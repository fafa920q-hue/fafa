import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import OpenAI from 'openai';
import { sql, audit } from '../../../packages/db/src';
import { resolveAccess } from '../../../packages/auth/src/business-access';
import { assertServiceOpen } from '../../../packages/auth/src/service-policy';
import {
  allowed,
  budget,
  configuration,
  fits,
} from '../../../packages/auth/src/platform-ai';
import {
  activeAiStatuses,
  repositoryForUser,
} from '../../../packages/auth/src/codex-execution';
import { pricing } from '../../../packages/auth/src/platform-models';
import { unseal } from '../../../packages/shared/src/crypto';
import {
  platformTaskAccount,
  recordPlatformError,
} from '../../worker/src/platform-ai';
import { openBroker } from './broker';
import {
  createContainer,
  destroyContainer,
  docker,
  runContainer,
  runtimeFiles,
  runtimeConfiguration,
} from './sandbox';

const exec = promisify(execFile);
export const redact = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[oprsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
      '[REDACTED]',
    );

async function scoped(task: any, db: any = sql) {
  const [row] = await db`select data->>'status' as status,requested_action
    from ai_tasks where id=${task.id} and owner_id=${task.owner_id} and kind='CODEX' and revoked_at is null`;
  if (
    !row ||
    !activeAiStatuses.includes(row.status) ||
    row.requested_action === 'CANCEL'
  )
    return;
  const [raw] =
    await db`select * from users where id=${task.owner_id} and not disabled and deleted_at is null`;
  const user = raw ? await resolveAccess(raw, db) : null;
  if (!user || !allowed(user) || !user._access.aiQuota.dailyLimit) return;
  await assertServiceOpen(user, db);
  const repo = await repositoryForUser(db, task.owner_id, task.codex_repo_id);
  if (
    !repo ||
    repo.commit_sha !== task.data.commit ||
    (task.data.recipe !== 'NONE' && repo.test_recipe !== task.data.recipe)
  )
    return;
  const account = await platformTaskAccount(task, user, db);
  return account && { row, account, repo };
}
async function dispatch(task: any) {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77708)`;
    const scope = await scoped(task, tx);
    if (
      !scope ||
      scope.row.status !== 'RUNNING' ||
      scope.row.requested_action === 'PAUSE'
    )
      return false;
    const { policy, quota } = await configuration(tx, task.owner_id);
    const zone = policy.timeZone,
      a = scope.account;
    const global = await budget(tx, {}, zone);
    const user = await budget(tx, { user: task.owner_id }, zone);
    if (
      global.daily > policy.globalDaily ||
      global.monthly > policy.globalMonthly ||
      user.dayTokens > quota.dailyTokens ||
      !fits(user, quota.limits, 0) ||
      !fits(
        await budget(tx, { project: a.project_id }, zone),
        policy.project,
        0,
      ) ||
      !fits(
        await budget(tx, { account: a.id }, zone),
        { daily: Number(a.daily_micros), monthly: Number(a.monthly_micros) },
        0,
      ) ||
      (policy.routing === 'ACCOUNT' && policy.target !== a.id) ||
      (policy.routing === 'PROJECT' && policy.target !== a.project_id)
    )
      return false;
    const [row] =
      await tx`update ai_platform_usage set dispatched_at=coalesce(dispatched_at,now())
      where task_id=${task.id} and charged_micros is null and created_at >= date_trunc('day',now(),${zone})
      returning task_id`;
    return !!row;
  });
}
export async function runCodexTask(task: any, shutdown: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), 'fafa-codex-job-'));
  const controller = new AbortController();
  const limit = AbortSignal.timeout(8 * 60_000);
  const signal = AbortSignal.any([controller.signal, shutdown, limit]);
  const original = join(dir, 'original'),
    workspace = join(dir, 'workspace');
  const socket = join(dir, 'model.sock');
  let container = '';
  let broker: Awaited<ReturnType<typeof openBroker>> | undefined;
  let monitorTimer: NodeJS.Timeout | undefined;
  let monitor: Promise<void> | undefined;
  let status = 'FAILED';
  let phase = 'PREPARING';
  let note = '隔离任务未完成';
  let patch = '';
  let log = '';
  let saved = '';
  let line = '';
  let cancelled = false;
  const append = (s: string) => {
    log = (log + redact(s) + '\n').slice(-14000);
  };
  const persist = async (data: Record<string, unknown>) => {
    await sql`update ai_tasks set data=data||${sql.json(data)},updated_at=now()
      where id=${task.id} and kind='CODEX' and data->>'status'=any(${activeAiStatuses as unknown as string[]}::text[])`;
  };
  function consume(chunk: string) {
    line = (line + chunk).slice(-64000);
    let index;
    while ((index = line.indexOf('\n')) >= 0) {
      const entry = line.slice(0, index);
      line = line.slice(index + 1);
      try {
        const event = JSON.parse(entry);
        if (event.type === 'thread.started') append('官方 Codex 进程已启动');
        const item = event.item;
        if (
          event.type === 'item.completed' &&
          item?.type === 'agent_message' &&
          typeof item.text === 'string'
        )
          append(item.text.slice(0, 6000));
        if (
          event.type === 'item.completed' &&
          item?.type === 'mcp_tool_call' &&
          item.server === 'workspace' &&
          ['read_file', 'write_file', 'list_files'].includes(item.tool)
        )
          append(
            '文件工具 ' +
              item.tool +
              ' · ' +
              (item.status === 'completed' ? '完成' : '未完成'),
          );
      } catch {
        /* Ignore unstructured diagnostics and tool arguments. */
      }
    }
  }
  async function watch() {
    if (signal.aborted) return;
    const scope = await scoped(task);
    if (!scope) {
      cancelled = true;
      controller.abort();
      return;
    }
    const action = scope.row.requested_action;
    if (
      container &&
      phase === 'RUNNING' &&
      action === 'PAUSE' &&
      scope.row.status === 'RUNNING'
    ) {
      await docker(['pause', container], signal);
      append('隔离容器已暂停');
      await sql`update ai_tasks set data=data||'{"status":"PAUSED"}', requested_action=null,updated_at=now()
        where id=${task.id} and requested_action='PAUSE' and data->>'status'='RUNNING'`;
    } else if (
      container &&
      phase === 'RUNNING' &&
      action === 'RESUME' &&
      scope.row.status === 'PAUSED'
    ) {
      await docker(['unpause', container], signal);
      append('隔离容器已恢复');
      await sql`update ai_tasks set data=data||'{"status":"RUNNING"}', requested_action=null,updated_at=now()
        where id=${task.id} and requested_action='RESUME' and data->>'status'='PAUSED'`;
    }
    if (saved !== log) {
      saved = log;
      await persist({ output: saved });
    }
  }
  monitorTimer = setInterval(() => {
    if (!monitor)
      monitor = watch()
        .catch(() => controller.abort())
        .finally(() => {
          monitor = undefined;
        });
  }, 650);
  try {
    const scope = await scoped(task);
    if (!scope) throw Error('ACCESS');
    const rate = pricing.parse(scope.account.pricing);
    await mkdir(original, { mode: 0o700 });
    await exec(
      '/usr/bin/python3',
      [
        join(runtimeFiles, 'archive.py'),
        scope.repo.github_owner,
        scope.repo.github_repo,
        scope.repo.commit_sha,
        original,
        join(dir, 'snapshot.zip'),
      ],
      { signal, timeout: 60_000, maxBuffer: 8000 },
    );
    await cp(original, workspace, { recursive: true, errorOnExist: true });
    if (!(await scoped(task))) throw Error('ACCESS');
    const key = unseal(scope.account.secret);
    const client = new OpenAI({
      apiKey: key,
      project: scope.account.project_id,
      baseURL: 'https://api.openai.com/v1',
      timeout: 65_000,
      maxRetries: 0,
      logLevel: 'off',
    });
    broker = await openBroker({
      socket,
      rate,
      model: task.data.model,
      maxOutput: task.data.maxOutputTokens,
      signal,
      responses: client.responses,
      beforeRequest: async () => (await scoped(task))?.row.status === 'RUNNING',
      beforeBillable: () => dispatch(task),
      providerError: (error) => recordPlatformError(task, error),
    });
    const prefix = runtimeConfiguration().namespace + '-' + task.id;
    container = await createContainer({
      workspace,
      socket,
      name: prefix,
      recipe: 'CODEX',
      model: task.data.model,
      context: rate.context,
    });
    phase = 'RUNNING';
    append('已检出管理员批准的固定 GitHub 提交');
    await persist({ status: phase, output: log });
    const code = await runContainer(
      container,
      'Use the workspace MCP tools to read and edit files. Shell and network are unavailable. Approved tests run separately.\n\n' +
        task.data.prompt,
      signal,
      consume,
    );
    if (code !== 0 || signal.aborted) throw Error('CODEX_EXIT');
    await destroyContainer(container);
    container = '';
    let testFailed = false;
    if (task.data.recipe === 'NODE_TEST') {
      phase = 'TESTING';
      append('开始已批准的 node --test');
      await persist({ status: phase, output: log });
      container = await createContainer({
        workspace,
        name: prefix + '-test',
        recipe: 'NODE_TEST',
      });
      let summary = '';
      const testCode = await runContainer(
        container,
        '',
        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        (chunk) => {
          summary = (summary + redact(chunk)).slice(-6000);
        },
      );
      append(summary);
      testFailed = testCode !== 0 || !/^# tests [1-9][0-9]*$/m.test(summary);
      append(testFailed ? '测试未通过' : '测试退出码 0');
    }
    if (signal.aborted || !(await scoped(task))) throw Error('ACCESS');
    try {
      const result = await exec(
        '/usr/bin/git',
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          'original',
          'workspace',
        ],
        {
          cwd: dir,
          maxBuffer: 260000,
          timeout: 10000,
          env: {
            PATH: '/usr/bin:/bin',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        },
      );
      patch = redact(result.stdout).slice(0, 120000);
    } catch (error) {
      const e = error as { code?: number; stdout?: string };
      if (e.code === 1 && e.stdout) patch = redact(e.stdout).slice(0, 120000);
      else append('无法生成完整补丁，工作区结果受大小限制');
    }
    status = testFailed ? 'FAILED' : 'COMPLETED';
    note = testFailed ? '已批准的测试未通过' : '';
  } catch {
    status =
      cancelled || shutdown.aborted
        ? 'CANCELLED'
        : limit.aborted
          ? 'TIMEOUT'
          : 'FAILED';
    append(
      phase === 'PREPARING'
        ? '准备工作区或授权检查失败'
        : '运行中断，未自动重试',
    );
  } finally {
    clearInterval(monitorTimer);
    controller.abort();
    await monitor;
    await destroyContainer(container);
    try {
      const usage = await broker?.close();
      if (usage?.overrun)
        await sql`update ai_platform_accounts set enabled=false,health='ERROR',last_error='USAGE_EXCEEDED_RESERVATION' where id=${task.platform_account_id}`;
      if (usage && usage.started > 0 && usage.started === usage.settled)
        await sql`update ai_platform_usage set charged_micros=${usage.micros}, input_tokens=${usage.input},
          output_tokens=${usage.output},cached_tokens=${usage.cached},cache_write_tokens=${usage.written}
          where task_id=${task.id} and charged_micros is null`;
      else
        await sql`update ai_platform_usage set charged_micros=0 where task_id=${task.id}
        and dispatched_at is null and charged_micros is null`;
      await sql`update ai_tasks set data=data||${sql.json({ status, output: log, patch, error: status === 'FAILED' ? note : null })},
        requested_action=null,updated_at=now() where id=${task.id} and kind='CODEX'
        and data->>'status'=any(${activeAiStatuses as unknown as string[]}::text[])`;
      await audit(task.owner_id, 'ai.codex_finished', task.id);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }
}

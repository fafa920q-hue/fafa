import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import {
  resolveAccess,
  teamServiceAllowed,
} from '../../../packages/auth/src/business-access';
import {
  assertServiceOpen,
  readServicePolicy,
  readAiQuota,
} from '../../../packages/auth/src/service-policy';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  aiProviderSchema,
  anthropicApiEnabled,
} from '../../../packages/shared/src';
import { sql, audit } from '../../../packages/db/src';
import { seal, unseal } from '../../../packages/shared/src/crypto';
import { safeFetch } from '../../../packages/subscription/src/network';
import {
  parseSubscription,
  identity,
  nodeMetadata,
  type Node,
} from '../../../packages/subscription/src';
export async function runSubscriptionJob(job: any) {
  const [source] =
    await sql`select s.* from node_sources s join users u on u.id=s.owner_id where s.id=${job.source_id} and s.revoked_at is null and not u.disabled and u.deleted_at is null`;
  if (
    !source ||
    !source.data.enabled ||
    source.data.demo ||
    source.data.kind !== 'REMOTE_SUBSCRIPTION' ||
    process.env.DEMO_MODE === 'true'
  )
    throw Error('源不可用或演示模式');
  const headers: Record<string, string> = {};
  if (source.data.etag) headers['If-None-Match'] = source.data.etag;
  if (source.data.lastModified)
    headers['If-Modified-Since'] = source.data.lastModified;
  const result = await safeFetch(unseal(source.secret), headers);
  const nodes = result.status === 304 ? null : parseSubscription(result.body);
  if (nodes && !nodes.length) throw Error('订阅没有有效节点');
  return sql.begin(async (tx) => {
    // Network I/O is outside the lock; recheck the latest configuration before committing.
    const [current] =
      await tx`select s.* from node_sources s join users u on u.id=s.owner_id where s.id=${source.id} and s.revoked_at is null and not u.disabled and u.deleted_at is null for update of s`;
    if (
      !current ||
      !current.data.enabled ||
      current.data.demo ||
      current.data.kind !== 'REMOTE_SUBSCRIPTION' ||
      current.data.syncRevision !== source.data.syncRevision ||
      JSON.stringify(current.secret) !== JSON.stringify(source.secret)
    )
      return { superseded: true };
    if (!nodes) {
      await tx`update node_sources set data=data || ${tx.json({ lastSuccess: new Date().toISOString(), status: 'READY', error: null })},updated_at=now() where id=${source.id}`;
      return { unchanged: true };
    }
    const previous =
      await tx`select * from nodes where source_id=${source.id} order by updated_at desc`;
    const old = new Set(
      previous
        .filter((n) => !n.revoked_at)
        .map((n) => identity(JSON.parse(unseal(n.secret)) as Node)),
    );
    const overrides = new Map<string, any>();
    for (const row of previous) {
      const key = identity(JSON.parse(unseal(row.secret)) as Node);
      if (!overrides.has(key)) overrides.set(key, row.data);
    }
    const accepted = nodes.filter(
      (node) => !overrides.get(identity(node))?.userDeleted,
    );
    const fresh = new Set(accepted.map(identity));
    const diff = {
      added: [...fresh].filter((key) => !old.has(key)).length,
      removed: [...old].filter((key) => !fresh.has(key)).length,
    };
    await tx`update nodes set revoked_at=now() where source_id=${source.id} and revoked_at is null`;
    for (const node of accepted) {
      const saved = overrides.get(identity(node));
      await tx`insert into nodes(owner_id,source_id,data,secret) values(${source.owner_id},${source.id},${tx.json({ ...nodeMetadata(node, current.data.country), group: current.data.group || '', ...(saved?.overrides || {}), overrides: saved?.overrides || {} })},${tx.json(seal(JSON.stringify(node)))})`;
    }
    await tx`update node_sources set data=data || ${tx.json({ nodeCount: accepted.length, lastSuccess: new Date().toISOString(), status: 'READY', error: null, etag: result.etag || null, lastModified: result.modified || null })},updated_at=now() where id=${source.id}`;
    return diff;
  });
}
export async function tick() {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77703)`;
    const sources =
      await tx`select s.* from node_sources s join users u on u.id=s.owner_id where s.revoked_at is null and not u.disabled and u.deleted_at is null and s.data->>'kind'='REMOTE_SUBSCRIPTION' and s.data->>'enabled'='true' and coalesce((s.data->>'lastScheduled')::timestamptz,to_timestamp(0))<now()-interval '1 hour' and not exists(select 1 from background_jobs j where j.source_id=s.id and j.data->>'status' in ('QUEUED','RUNNING'))`;
    for (const s of sources) {
      const [current] =
        await tx`select id from node_sources where id=${s.id} and revoked_at is null and data->>'enabled'='true' for update`;
      if (
        !current ||
        (
          await tx`select id from background_jobs where source_id=${s.id} and data->>'status' in ('QUEUED','RUNNING')`
        ).length
      )
        continue;
      await tx`insert into background_jobs(owner_id,source_id,data) values(${s.owner_id},${s.id},${tx.json({ type: 'SUBSCRIPTION_SYNC', status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })})`;
      await tx`update node_sources set data=data || ${tx.json({ lastScheduled: new Date().toISOString() })} where id=${s.id}`;
    }
  });
  const job = await sql.begin(async (tx) => {
    const [r] =
      await tx`select j.* from background_jobs j join node_sources s on s.id=j.source_id join users u on u.id=s.owner_id where j.revoked_at is null and j.data->>'type'='SUBSCRIPTION_SYNC' and j.data->>'status'='QUEUED' and (j.data->>'nextRun')::timestamptz<=now() and s.revoked_at is null and s.data->>'enabled'='true' and s.data->>'kind'='REMOTE_SUBSCRIPTION' and not u.disabled and u.deleted_at is null order by j.created_at for update of j skip locked limit 1`;
    if (r)
      await tx`update background_jobs set data=data || '{"status":"RUNNING"}',updated_at=now() where id=${r.id}`;
    return r;
  });
  if (job) {
    try {
      const diff = await runSubscriptionJob(job);
      const changed =
        await sql`update background_jobs set data=data || '{"status":"COMPLETED"}',updated_at=now() where id=${job.id} and data->>'status'='RUNNING' returning id`;
      if (changed.length)
        await sql`insert into subscription_sync_runs(owner_id,data) values(${job.owner_id},${sql.json({ sourceId: job.source_id, status: 'COMPLETED', diff })})`;
    } catch {
      await sql.begin(async (tx) => {
        await tx`select id from node_sources where id=${job.source_id} for update`;
        const attempt = (job.data.attempt || 0) + 1;
        const status = attempt >= 3 ? 'FAILED' : 'QUEUED';
        const changed =
          await tx`update background_jobs set data=data || ${tx.json({ status, attempt, error: '订阅刷新失败，请检查授权、格式与网络', nextRun: new Date(Date.now() + 2 ** attempt * 60000).toISOString() })},updated_at=now() where id=${job.id} and data->>'status'='RUNNING' returning id`;
        if (!changed.length) return;
        await tx`update node_sources set data=data || '{"status":"ERROR","error":"刷新失败，保留最后成功版本"}' where id=${job.source_id} and revoked_at is null`;
        await tx`insert into subscription_sync_runs(owner_id,data) values(${job.owner_id},${tx.json({ sourceId: job.source_id, status: 'FAILED', attempt })})`;
      });
    }
  }
  const task = await sql.begin(async (tx) => {
    const [r] =
      await tx`select t.* from ai_tasks t join users u on u.id=t.owner_id where t.data->>'status'='QUEUED' and not u.disabled order by t.created_at for update of t skip locked limit 1`;
    if (r)
      await tx`update ai_tasks set data=data || '{"status":"RUNNING"}',updated_at=now() where id=${r.id}`;
    return r;
  });
  if (task) await runAiTask(task);
}
export async function runAiTask(task: any) {
  let output = '';
  let completed = false;
  let status = 'COMPLETED';
  let failure = '请求失败，请检查 API Key、额度和模型权限';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let accessRevoked = false;
  const accessWatchdog = setInterval(async () => {
    try {
      const [running] =
        await sql`select id from ai_tasks where id=${task.id} and owner_id=${task.owner_id} and data->>'status'='RUNNING'`;
      if (
        !running ||
        (task.data.provider === 'ANTHROPIC_API' && !anthropicApiEnabled())
      )
        throw Error('ACCESS_REVOKED');
      const [rawUser] =
        await sql`select * from users where id=${task.owner_id} and not disabled and deleted_at is null`;
      const user = rawUser ? await resolveAccess(rawUser) : null;
      if (user) await assertServiceOpen(user);
      const policy = await readServicePolicy();
      const quota = await readAiQuota(task.owner_id);
      const [account] =
        await sql`SELECT a.id FROM ai_accounts a JOIN users u ON u.id=a.owner_id WHERE a.id=${task.account_id} AND a.revoked_at IS NULL AND NOT u.disabled AND u.deleted_at IS NULL`;
      if (
        !account ||
        quota.dailyLimit === 0 ||
        (task.data.service &&
          (!teamServiceAllowed(user, policy) ||
            policy.ai.accountId !== task.account_id))
      )
        throw Error('ACCESS_REVOKED');
      if (!user || !capabilityAllowed(user, 'codex')) {
        accessRevoked = true;
        controller.abort();
      }
    } catch {
      accessRevoked = true;
      controller.abort();
    }
  }, 1000);
  try {
    const [rawUser] =
      await sql`select * from users where id=${task.owner_id} and not disabled and deleted_at is null`;
    const user = rawUser ? await resolveAccess(rawUser) : null;
    if (!user || !capabilityAllowed(user, 'codex'))
      throw Error('CAPABILITY_REQUIRED');
    await assertServiceOpen(user);
    const policy = await readServicePolicy();
    const quota = await readAiQuota(task.owner_id);
    if (quota.dailyLimit === 0) throw Error('AI_QUOTA_REVOKED');
    if (
      task.data.service &&
      (!teamServiceAllowed(user, policy) ||
        policy.ai.accountId !== task.account_id)
    )
      throw Error('AI_SERVICE_CLOSED');
    const [account] =
      await sql`select a.* from ai_accounts a join users u on u.id=a.owner_id where a.id=${task.account_id} and (a.owner_id=${task.owner_id} or (${task.data.service === true} and u.role='Owner')) and not u.disabled and u.deleted_at is null and a.revoked_at is null`;
    if (process.env.DEMO_MODE === 'true' || !account) throw Error('未配置');
    const provider = aiProviderSchema.parse(task.data.provider ?? 'OPENAI_API');
    if (
      (account.data.provider ?? 'OPENAI_API') !== provider ||
      (task.data.service && provider !== 'OPENAI_API')
    )
      throw Error('AI_PROVIDER_MISMATCH');
    if (provider === 'ANTHROPIC_API' && !anthropicApiEnabled())
      throw Error('CLAUDE_API_DISABLED');
    const credential =
      provider === 'ANTHROPIC_API' ? account.anthropic_secret : account.secret;
    if (!credential) throw Error('未配置');
    const apiKey = unseal(credential);
    const maxTokens = Math.min(
      Number(task.data.maxOutputTokens) || 2000,
      task.data.service ? policy.ai.maxOutputTokens : 2000,
    );
    const stream =
      provider === 'ANTHROPIC_API'
        ? await new Anthropic({
            apiKey,
            authToken: null,
            logLevel: 'off',
            baseURL: 'https://api.anthropic.com',
            timeout: 120000,
            maxRetries: 0,
          }).messages.create(
            {
              model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
              messages: [{ role: 'user', content: task.data.prompt }],
              max_tokens: maxTokens,
              stream: true,
            },
            { signal: controller.signal },
          )
        : await new OpenAI({
            apiKey,
            timeout: 120000,
            maxRetries: 0,
          }).responses.create(
            {
              model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
              input: task.data.prompt,
              max_output_tokens: maxTokens,
              stream: true,
              store: false,
            },
            { signal: controller.signal },
          );
    let claudeUsage:
      { input_tokens: number; output_tokens: number } | undefined;
    let last = 0;
    for await (const event of stream) {
      const [rawState] =
        await sql`select t.data->>'status' as status,u.* from ai_tasks t join users u on u.id=t.owner_id where t.id=${task.id}`;
      const state = rawState ? await resolveAccess(rawState) : null;
      if (
        !state ||
        state.status === 'CANCELLED' ||
        state.disabled ||
        !capabilityAllowed(state, 'codex')
      ) {
        status = 'CANCELLED';
        controller.abort();
        break;
      }
      if (event.type === 'response.output_text.delta') output += event.delta;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      )
        output += event.delta.text;
      if (event.type === 'message_start')
        claudeUsage = {
          input_tokens: event.message.usage.input_tokens,
          output_tokens: event.message.usage.output_tokens,
        };
      if (event.type === 'message_delta' && claudeUsage)
        claudeUsage.output_tokens = event.usage.output_tokens;
      if (
        event.type === 'response.completed' ||
        event.type === 'message_stop'
      ) {
        completed = true;
        const usage =
          event.type === 'response.completed'
            ? event.response.usage
            : claudeUsage;
        if (usage)
          await sql`UPDATE ai_tasks SET data=data || ${sql.json({ usage })},updated_at=now() WHERE id=${task.id} AND data->>'status'='RUNNING'`;
      }
      if (event.type === 'response.failed' || event.type === 'error')
        throw Error('PROVIDER_RESPONSE_FAILED');
      if (Date.now() - last > 200) {
        await sql`update ai_tasks set data=data || ${sql.json({ output })},updated_at=now() where id=${task.id} and data->>'status'='RUNNING'`;
        last = Date.now();
      }
    }
    if (status === 'COMPLETED' && (!completed || controller.signal.aborted))
      throw Error('PROVIDER_RESPONSE_INCOMPLETE');
    if (status === 'COMPLETED') {
      const lastUsedAt = new Date().toISOString();
      await sql`update ai_accounts set data=data || ${sql.json({ status: 'VERIFIED', verifiedAt: lastUsedAt, lastUsedAt })} where id=${task.account_id} and revoked_at is null`;
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      if (error.status === 401 || error.status === 403)
        failure = 'Claude API Key 无效或没有所选模型的访问权限';
      if (error.status === 402) failure = 'Claude API 账单或可用余额异常';
      if (error.status === 429) failure = 'Claude API 请求受到频率或额度限制';
      if (error.status === 503 || error.status === 529)
        failure = 'Claude API 暂时不可用';
    }
    status = accessRevoked
      ? 'CANCELLED'
      : controller.signal.aborted
        ? 'TIMEOUT'
        : 'FAILED';
  } finally {
    clearTimeout(timeout);
    clearInterval(accessWatchdog);
    await sql`update ai_tasks set data=data || ${sql.json({ status, output, error: status === 'FAILED' ? failure : null })},updated_at=now() where id=${task.id} and data->>'status'='RUNNING'`;
    await audit(task.owner_id, 'ai.task_finished', task.id);
  }
}

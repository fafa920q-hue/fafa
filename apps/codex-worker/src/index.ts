import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from '../../../packages/db/src';
import { assertEnvironment } from '../../../packages/auth/src';
import { codexExecutionEnabled } from '../../../packages/auth/src/codex-execution';
import { assertRuntimeDatabaseRole } from '../../../infra/scripts/check-runtime-db';
import { clearNamespace, verifyRuntime } from './sandbox';
import { runCodexTask } from './runner';

async function main() {
  if (!codexExecutionEnabled() || process.env.DEMO_MODE === 'true')
    throw Error('Codex 执行开关未启用');
  assertEnvironment();
  await assertRuntimeDatabaseRole();
  const runtime = await verifyRuntime();
  const lock = await sql.reserve();
  const [result] = await lock`select pg_try_advisory_lock(77812) as acquired`;
  if (!result.acquired) {
    lock.release();
    throw Error('本测试库已有执行 Worker');
  }
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  let timer: NodeJS.Timeout | undefined;
  const heartbeat =
    () => sql`insert into settings(key,value) values('codex_execution_heartbeat', 'true'::jsonb)
    on conflict(key) do update set value=excluded.value,updated_at=now()`;
  try {
    await clearNamespace(runtime.namespace);
    await sql`update ai_tasks set data=data||'{"status":"TIMEOUT","error":"执行服务已重启，未自动重放"}',
      requested_action=null,updated_at=now() where kind='CODEX'
      and data->>'status' in ('PREPARING','RUNNING','PAUSED','TESTING')`;
    await sql`update ai_platform_usage l set charged_micros=0 from ai_tasks t
      where t.id=l.task_id and t.kind='CODEX' and l.dispatched_at is null and l.charged_micros is null
      and t.data->>'status' in ('TIMEOUT','FAILED','CANCELLED')`;
    await heartbeat();
    timer = setInterval(() => {
      void heartbeat().catch(() => {});
    }, 7000);
    console.log('FAFA ONE Codex 隔离执行服务已启动');
    while (!controller.signal.aborted) {
      try {
        const task = await sql.begin(async (tx) => {
          const [row] =
            await tx`select t.* from ai_tasks t join users u on u.id=t.owner_id
            where t.kind='CODEX' and t.data->>'status'='QUEUED' and t.revoked_at is null and not u.disabled
            and u.deleted_at is null order by t.created_at for update of t skip locked limit 1`;
          if (row)
            await tx`update ai_tasks set data=data||'{"status":"PREPARING"}',updated_at=now() where id=${row.id}`;
          return row;
        });
        if (task) await runCodexTask(task, controller.signal);
      } catch {
        console.error('Codex 执行服务处理失败，未记录请求内容或凭据');
      }
      await sleep(1000);
    }
  } finally {
    clearInterval(timer);
    await sql`update settings set updated_at=to_timestamp(0) where key='codex_execution_heartbeat'`.catch(
      () => {},
    );
    await lock`select pg_advisory_unlock(77812)`.catch(() => {});
    lock.release();
  }
}
try {
  await main();
} catch {
  console.error(
    'Codex 执行服务启动失败，请检查独立执行环境、Docker、CLI 版本和数据库权限',
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}

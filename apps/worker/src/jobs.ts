import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import OpenAI from 'openai';
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
  let status = 'COMPLETED';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let accessRevoked = false;
  const accessWatchdog = setInterval(async () => {
    try {
      const [user] =
        await sql`select * from users where id=${task.owner_id} and not disabled and deleted_at is null`;
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
    const [user] =
      await sql`select * from users where id=${task.owner_id} and not disabled and deleted_at is null`;
    if (!user || !capabilityAllowed(user, 'codex'))
      throw Error('CAPABILITY_REQUIRED');
    const [account] =
      await sql`select * from ai_accounts where id=${task.account_id} and owner_id=${task.owner_id} and revoked_at is null`;
    if (process.env.DEMO_MODE === 'true' || !account?.secret)
      throw Error('未配置');
    const client = new OpenAI({
      apiKey: unseal(account.secret),
      timeout: 120000,
      maxRetries: 0,
    });
    const stream = await client.responses.create(
      {
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: task.data.prompt,
        max_output_tokens: 2000,
        stream: true,
        store: false,
      },
      { signal: controller.signal },
    );
    let last = 0;
    for await (const event of stream) {
      const [state] =
        await sql`select t.data->>'status' as status,u.disabled,u.role,u.codex_tasks_enabled,u.codex_tasks_until from ai_tasks t join users u on u.id=t.owner_id where t.id=${task.id}`;
      if (
        state.status === 'CANCELLED' ||
        state.disabled ||
        !capabilityAllowed(state, 'codex')
      ) {
        status = 'CANCELLED';
        controller.abort();
        break;
      }
      if (event.type === 'response.output_text.delta') output += event.delta;
      if (Date.now() - last > 200) {
        await sql`update ai_tasks set data=data || ${sql.json({ output })},updated_at=now() where id=${task.id} and data->>'status'='RUNNING'`;
        last = Date.now();
      }
    }
    await sql`update ai_accounts set data=data || ${sql.json({ status: 'VERIFIED', verifiedAt: new Date().toISOString() })} where id=${task.account_id}`;
  } catch {
    status = accessRevoked
      ? 'CANCELLED'
      : controller.signal.aborted
        ? 'TIMEOUT'
        : 'FAILED';
  } finally {
    clearTimeout(timeout);
    clearInterval(accessWatchdog);
    await sql`update ai_tasks set data=data || ${sql.json({ status, output, error: status === 'FAILED' ? '请求失败，请检查 API Key、额度和模型权限' : null })},updated_at=now() where id=${task.id} and data->>'status'='RUNNING'`;
    await audit(task.owner_id, 'ai.task_finished', task.id);
  }
}

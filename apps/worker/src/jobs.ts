import OpenAI from 'openai';
import { sql, audit } from '../../../packages/db/src';
import { seal, unseal } from '../../../packages/shared/src/crypto';
import { safeFetch } from '../../../packages/subscription/src/network';
import {
  parseSubscription,
  identity,
  type Node,
} from '../../../packages/subscription/src';
export async function runSubscriptionJob(job: any) {
  const [source] =
    await sql`select s.* from node_sources s join users u on u.id=s.owner_id where s.id=${job.source_id} and s.revoked_at is null and not u.disabled`;
  if (
    !source ||
    !source.data.enabled ||
    source.data.demo ||
    process.env.DEMO_MODE === 'true'
  )
    throw Error('源不可用或演示模式');
  const headers: Record<string, string> = {};
  if (source.data.etag) headers['If-None-Match'] = source.data.etag;
  if (source.data.lastModified)
    headers['If-Modified-Since'] = source.data.lastModified;
  const result = await safeFetch(unseal(source.secret), headers);
  if (result.status === 304) {
    await sql`update node_sources set data=data || ${sql.json({ lastSuccess: new Date().toISOString(), status: 'READY', error: null })} where id=${source.id}`;
    return { unchanged: true };
  }
  const nodes = parseSubscription(result.body);
  const previous =
    await sql`select secret from nodes where source_id=${source.id} and revoked_at is null`;
  const old = new Set(
    previous.map((n) => identity(JSON.parse(unseal(n.secret)) as Node)),
  );
  const fresh = new Set(nodes.map(identity));
  const diff = {
    added: [...fresh].filter((x) => !old.has(x)).length,
    removed: [...old].filter((x) => !fresh.has(x)).length,
  };
  await sql.begin(async (tx) => {
    await tx`update nodes set revoked_at=now() where source_id=${source.id} and revoked_at is null`;
    for (const n of nodes)
      await tx`insert into nodes(owner_id,source_id,data,secret) values(${source.owner_id},${source.id},${tx.json({ name: n.name, protocol: n.protocol, country: source.data.country })},${tx.json(seal(JSON.stringify(n)))})`;
    await tx`update node_sources set data=data || ${tx.json({ nodeCount: nodes.length, lastSuccess: new Date().toISOString(), status: 'READY', error: null, etag: result.etag || null, lastModified: result.modified || null })},updated_at=now() where id=${source.id}`;
  });
  return diff;
}
export async function tick() {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77703)`;
    const sources =
      await tx`select s.* from node_sources s join users u on u.id=s.owner_id where s.revoked_at is null and not u.disabled and s.data->>'kind'='REMOTE_SUBSCRIPTION' and s.data->>'enabled'='true' and coalesce((s.data->>'lastScheduled')::timestamptz,to_timestamp(0))<now()-interval '1 hour' and not exists(select 1 from background_jobs j where j.source_id=s.id and j.data->>'status' in ('QUEUED','RUNNING'))`;
    for (const s of sources) {
      await tx`insert into background_jobs(owner_id,source_id,data) values(${s.owner_id},${s.id},${tx.json({ type: 'SUBSCRIPTION_SYNC', status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })})`;
      await tx`update node_sources set data=data || ${tx.json({ lastScheduled: new Date().toISOString() })} where id=${s.id}`;
    }
  });
  const job = await sql.begin(async (tx) => {
    const [r] =
      await tx`select * from background_jobs where data->>'status'='QUEUED' and (data->>'nextRun')::timestamptz<=now() order by created_at for update skip locked limit 1`;
    if (r)
      await tx`update background_jobs set data=data || '{"status":"RUNNING"}',updated_at=now() where id=${r.id}`;
    return r;
  });
  if (job) {
    try {
      const diff = await runSubscriptionJob(job);
      await sql`update background_jobs set data=data || '{"status":"COMPLETED"}',updated_at=now() where id=${job.id}`;
      await sql`insert into subscription_sync_runs(owner_id,data) values(${job.owner_id},${sql.json({ sourceId: job.source_id, status: 'COMPLETED', diff })})`;
    } catch {
      const attempt = (job.data.attempt || 0) + 1;
      const status = attempt >= 3 ? 'FAILED' : 'QUEUED';
      await sql`update background_jobs set data=data || ${sql.json({ status, attempt, error: '订阅刷新失败，请检查授权、格式与网络', nextRun: new Date(Date.now() + 2 ** attempt * 60000).toISOString() })},updated_at=now() where id=${job.id}`;
      await sql`update node_sources set data=data || '{"status":"ERROR","error":"刷新失败，保留最后成功版本"}' where id=${job.source_id}`;
      await sql`insert into subscription_sync_runs(owner_id,data) values(${job.owner_id},${sql.json({ sourceId: job.source_id, status: 'FAILED', attempt })})`;
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
  try {
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
        await sql`select t.data->>'status' as status,u.disabled from ai_tasks t join users u on u.id=t.owner_id where t.id=${task.id}`;
      if (state.status === 'CANCELLED' || state.disabled) {
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
    status = controller.signal.aborted ? 'TIMEOUT' : 'FAILED';
  } finally {
    clearTimeout(timeout);
    await sql`update ai_tasks set data=data || ${sql.json({ status, output, error: status === 'FAILED' ? '请求失败，请检查 API Key、额度和模型权限' : null })},updated_at=now() where id=${task.id} and data->>'status'='RUNNING'`;
    await audit(task.owner_id, 'ai.task_finished', task.id);
  }
}

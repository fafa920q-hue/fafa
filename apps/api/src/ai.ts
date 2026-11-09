import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, own, audit } from '../../../packages/db/src';
import { AppError, notFound } from '../../../packages/shared/src';
import {
  resolveAccess,
  teamServiceAllowed,
} from '../../../packages/auth/src/business-access';
import {
  assertServiceOpen,
  readServicePolicy,
  readAiQuota,
} from '../../../packages/auth/src/service-policy';
export async function registerAi(app: FastifyInstance, origins: string[]) {
  app.get('/api/ai/service', async (req) => {
    const policy = await readServicePolicy();
    const quota = await readAiQuota(req.actor.id);
    return {
      enabled:
        teamServiceAllowed(req.actor, policy) &&
        !!(
          await sql`SELECT a.id FROM ai_accounts a JOIN users u ON u.id=a.owner_id WHERE a.id=${policy.ai.accountId} AND a.revoked_at IS NULL AND a.secret IS NOT NULL AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.deleted_at IS NULL`
        ).length,
      quota,
      personalCodex: 'UNAVAILABLE',
      personalApi: 'AVAILABLE',
    };
  });
  app.post('/api/ai/select', async (req) => {
    const { accountId } = z.object({ accountId: z.uuid() }).parse(req.body);
    if (!(await own('ai_accounts', accountId, req.actor.id))) throw notFound();
    await sql.begin(async (tx) => {
      await tx`update ai_accounts set data=data || '{"selected":false}'::jsonb where owner_id=${req.actor.id}`;
      await tx`update ai_accounts set data=data || '{"selected":true}'::jsonb where id=${accountId} and owner_id=${req.actor.id}`;
    });
    return { ok: true };
  });
  app.get('/api/ai/tasks', async (req) =>
    (
      await sql`select id,account_id,data,created_at from ai_tasks where owner_id=${req.actor.id} and revoked_at is null order by created_at desc limit 50`
    ).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      ...r.data,
      createdAt: r.created_at,
    })),
  );
  app.post('/api/ai/tasks', async (req) => {
    const d = z
      .object({
        accountId: z.uuid().optional(),
        service: z.boolean().default(false),
        prompt: z.string().min(1).max(16000),
        workspace: z.string().max(300).default(''),
      })
      .parse(req.body);
    const policy = await readServicePolicy();
    const quota = await readAiQuota(req.actor.id);
    const [serviceAccount] =
      d.service && teamServiceAllowed(req.actor, policy) && policy.ai.accountId
        ? await sql`SELECT a.* FROM ai_accounts a JOIN users u ON u.id=a.owner_id WHERE a.id=${policy.ai.accountId} AND a.revoked_at IS NULL AND u.role='Owner' AND NOT u.disabled AND u.deleted_at IS NULL`
        : [];
    if (d.service && !serviceAccount)
      throw new AppError(409, 'AI_SERVICE_CLOSED', '管理员 AI 服务暂未开放');
    const account = d.service
      ? serviceAccount
      : d.accountId
        ? await own('ai_accounts', d.accountId, req.actor.id)
        : null;
    if (!account) throw notFound();
    if (process.env.DEMO_MODE === 'true' || !account.secret)
      throw new AppError(
        409,
        'AI_UNCONFIGURED',
        '演示模式或 API Key 未配置，未向外部发送请求',
      );
    const task = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${req.actor.id}))`;
      const [rawUser] =
        await tx`SELECT * FROM users WHERE id=${req.actor.id} FOR SHARE`;
      const current = rawUser ? await resolveAccess(rawUser, tx) : null;
      if (
        !current?._access.capabilities.codex ||
        (d.service && !teamServiceAllowed(current, await readServicePolicy(tx)))
      )
        throw new AppError(403, 'CAPABILITY_REQUIRED', 'AI 权限已撤销或到期');
      await assertServiceOpen(req.actor, tx);
      const [count] =
        await tx`select count(*)::int as n from ai_tasks where owner_id=${req.actor.id} and created_at>now()-interval '1 day'`;
      const [active] =
        await tx`select count(*)::int as n from ai_tasks where owner_id=${req.actor.id} and data->>'status' in ('QUEUED','RUNNING')`;
      const dailyLimit = d.service
        ? Math.min(quota.dailyLimit, policy.ai.dailyLimit)
        : quota.dailyLimit;
      const concurrency = d.service
        ? Math.min(quota.concurrency, policy.ai.concurrency)
        : quota.concurrency;
      if (count.n >= dailyLimit || active.n >= concurrency)
        throw new AppError(
          429,
          'AI_BUDGET',
          '已达到管理员设置的每日额度或并发限制',
        );
      const [r] =
        await tx`insert into ai_tasks(owner_id,account_id,data) values(${req.actor.id},${account.id},${tx.json({ prompt: d.prompt, workspace: d.workspace, service: d.service, status: 'QUEUED', output: '', maxOutputTokens: d.service ? policy.ai.maxOutputTokens : 2000 })}) returning id`;
      return r;
    });
    await audit(req.actor.id, 'ai.task_created', task.id);
    return task;
  });
  app.post('/api/ai/tasks/:id/cancel', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const rows =
      await sql`update ai_tasks set data=data || '{"status":"CANCELLED"}'::jsonb where id=${id} and owner_id=${req.actor.id} and data->>'status' in ('QUEUED','RUNNING') returning id`;
    if (!rows.length) throw notFound();
    await audit(req.actor.id, 'ai.task_cancelled', id);
    return { ok: true };
  });
  app.get('/api/ai/tasks/:id/events', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin))
      throw new AppError(403, 'ORIGIN', '来源不允许');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] =
      await sql`select id from ai_tasks where id=${id} and owner_id=${req.actor.id}`;
    if (!t) throw notFound();
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': origin || origins[0],
      Vary: 'Origin',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    reply.raw.on('close', () => (closed = true));
    for (let i = 0; i < 180 && !closed; i++) {
      const [r] =
        await sql`select data from ai_tasks where id=${id} and owner_id=${req.actor.id}`;
      reply.raw.write(`data: ${JSON.stringify(r.data)}\n\n`);
      if (!['QUEUED', 'RUNNING'].includes(r.data.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    reply.raw.end();
  });
}

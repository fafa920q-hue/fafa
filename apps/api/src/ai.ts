import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, own, audit } from '../../../packages/db/src';
import { AppError, notFound } from '../../../packages/shared/src';
export async function registerAi(app: FastifyInstance, origins: string[]) {
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
        accountId: z.uuid(),
        prompt: z.string().min(1).max(16000),
        workspace: z.string().max(300).default(''),
      })
      .parse(req.body);
    const account = await own('ai_accounts', d.accountId, req.actor.id);
    if (!account) throw notFound();
    if (process.env.DEMO_MODE === 'true' || !account.secret)
      throw new AppError(
        409,
        'AI_UNCONFIGURED',
        '演示模式或 API Key 未配置，未向外部发送请求',
      );
    const task = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${req.actor.id}))`;
      const [count] =
        await tx`select count(*)::int as n from ai_tasks where owner_id=${req.actor.id} and created_at>now()-interval '1 day'`;
      const [active] =
        await tx`select count(*)::int as n from ai_tasks where owner_id=${req.actor.id} and data->>'status' in ('QUEUED','RUNNING')`;
      if (count.n >= 20 || active.n >= 2)
        throw new AppError(
          429,
          'AI_BUDGET',
          '已达到每日 20 次或并发 2 个任务限制',
        );
      const [r] =
        await tx`insert into ai_tasks(owner_id,account_id,data) values(${req.actor.id},${d.accountId},${tx.json({ prompt: d.prompt, workspace: d.workspace, status: 'QUEUED', output: '', maxOutputTokens: 2000 })}) returning id`;
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

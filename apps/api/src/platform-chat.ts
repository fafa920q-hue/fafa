import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { AppError, notFound } from '../../../packages/shared/src';
import { platformAiEnabled } from '../../../packages/shared/src/platform-ai';
import { models } from '../../../packages/auth/src/platform-ai';
import { submitPlatformTask } from './platform-ai';

const title = z.string().trim().min(1).max(120);
const routeId = z.object({ id: z.uuid() });
function requireMode() {
  if (!platformAiEnabled()) throw notFound();
}

export async function registerPlatformChat(app: FastifyInstance) {
  app.get('/api/ai/chats', async (req, reply) => {
    requireMode();
    reply.header('Cache-Control', 'no-store');
    const { q } = z
      .object({ q: z.string().trim().max(100).default('') })
      .parse(req.query);
    return sql`select c.id,c.title,c.created_at,c.updated_at from ai_platform_chats c
      where c.owner_id=${req.actor.id} and c.deleted_at is null and
      (${q}='' or strpos(lower(c.title),lower(${q}))>0 or exists (
        select 1 from ai_tasks t where t.chat_id=c.id and t.owner_id=c.owner_id
          and (strpos(lower(t.data->>'prompt'),lower(${q}))>0 or strpos(lower(t.data->>'output'),lower(${q}))>0)))
      order by c.updated_at desc,c.id limit 100`;
  });
  app.post('/api/ai/chats', async (req) => {
    requireMode();
    const d = z
      .object({ title: title.default('新对话') })
      .parse(req.body ?? {});
    const [chat] =
      await sql`insert into ai_platform_chats(owner_id,title) values(${req.actor.id},${d.title}) returning id,title`;
    return chat;
  });
  app.get('/api/ai/chats/:id', async (req, reply) => {
    requireMode();
    reply.header('Cache-Control', 'no-store');
    const { id } = routeId.parse(req.params);
    const [chat] =
      await sql`select id,title from ai_platform_chats where id=${id} and owner_id=${req.actor.id} and deleted_at is null`;
    if (!chat) throw notFound();
    const rows =
      await sql`select id,data,created_at from ai_tasks where chat_id=${id} and owner_id=${req.actor.id}
      and revoked_at is null order by created_at desc,id desc limit 100`;
    return {
      ...chat,
      messages: rows.reverse().map((r) => ({
        id: r.id,
        prompt: r.data.prompt,
        output: r.data.output,
        model: r.data.model,
        status: r.data.status,
        error: r.data.error,
        retryOf: r.data.retryOf,
        createdAt: r.created_at,
      })),
    };
  });
  app.patch('/api/ai/chats/:id', async (req) => {
    requireMode();
    const { id } = routeId.parse(req.params);
    const d = z.strictObject({ title }).parse(req.body);
    const [row] =
      await sql`update ai_platform_chats set title=${d.title},updated_at=now()
      where id=${id} and owner_id=${req.actor.id} and deleted_at is null returning id,title`;
    if (!row) throw notFound();
    return row;
  });
  app.delete('/api/ai/chats/:id', async (req) => {
    requireMode();
    const { id } = routeId.parse(req.params);
    await sql.begin(async (tx) => {
      const [row] = await tx`update ai_platform_chats set deleted_at=now()
        where id=${id} and owner_id=${req.actor.id} and deleted_at is null returning id`;
      if (!row) throw notFound();
      await tx`update ai_tasks set data=data || '{"status":"CANCELLED"}',updated_at=now()
        where chat_id=${id} and owner_id=${req.actor.id} and data->>'status' in ('QUEUED','RUNNING')`;
    });
    await audit(req.actor.id, 'ai.chat_deleted', id);
    return { ok: true };
  });
  app.post('/api/ai/chats/:id/messages', async (req) => {
    requireMode();
    const { id } = routeId.parse(req.params);
    const d = z
      .strictObject({
        model: models,
        requestId: z.uuid(),
        prompt: z.string().trim().min(1).max(16000).optional(),
        retryOf: z.uuid().optional(),
        attachment: z
          .object({
            name: z
              .string()
              .trim()
              .max(120)
              .regex(/\.(txt|md|csv|json|log)$/i),
            text: z
              .string()
              .min(1)
              .max(8000)
              .refine(
                (text) =>
                  !text.includes(String.fromCharCode(0)) &&
                  Buffer.byteLength(text) <= 8000,
              ),
          })
          .optional(),
      })
      .parse(req.body);
    if (!!d.prompt === !!d.retryOf || (d.attachment && !d.prompt))
      throw new AppError(400, 'AI_CHAT_INPUT', '请提交消息或重试最近一次回复');
    return submitPlatformTask(
      req.actor,
      { model: d.model, prompt: d.prompt ?? '', workspace: '' },
      {
        id,
        requestId: d.requestId,
        retryOf: d.retryOf,
        attachment: d.attachment,
      },
    );
  });
}

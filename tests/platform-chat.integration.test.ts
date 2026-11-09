import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/server';
import { createSession } from '../packages/auth/src';
import { sql } from '../packages/db/src';
import { tick } from '../apps/worker/src/jobs';

const ids = [randomUUID(), randomUUID(), randomUUID()];
const model = 'test-fixture-dynamic-model';
const base = '/api/admin/ai-platform';
const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
const definition = {
  displayName: 'Fixture dynamic model',
  enabled: true,
  supportsChat: true,
  supportsCodex: false,
  defaultChat: true,
  defaultCodex: false,
  allowedUsers: [ids[1]],
  pricing: {
    context: 32768,
    input: 2_000_000,
    cached: 100_000,
    output: 10_000_000,
    cacheWrite: 2_500_000,
  },
  taskMicros: 500_000,
};
let app: Awaited<ReturnType<typeof buildApp>>;
let chatId: string;
const send = (
  who: number,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'GET',
  payload?: object,
) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      origin: 'http://localhost:5173',
      cookie: 'fafa_session=' + sessions[who].raw,
      'x-csrf-token': sessions[who].csrf,
    },
  });
function denyNetwork() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Unexpected provider request');
    }),
  );
}
beforeAll(async () => {
  const u = new URL(process.env.DATABASE_URL!);
  if (
    u.hostname !== '127.0.0.1' ||
    !/^\/fafa_platform_[a-f0-9]+_test$/.test(u.pathname)
  )
    throw Error('Dedicated platform test DB required');
  vi.stubEnv('PLATFORM_CODEX_ENABLED', 'true');
  vi.stubEnv('DEMO_MODE', 'false');
  denyNetwork();
  app = await buildApp();
  for (let i = 0; i < ids.length; i++) {
    const [user] =
      await sql`insert into users(id,email,name,role,codex_tasks_enabled)
      values (${ids[i]},${ids[i] + '@example.invalid'},'chat fixture',${i === 0 ? 'Owner' : 'Member'},true) returning *`;
    sessions.push(await createSession(user as any));
  }
});
afterAll(async () => {
  if (app) await sql`update users set deleted_at=now() where id in ${sql(ids)}`;
  await app?.close();
  await sql.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('verifies dynamic model IDs through the account Worker and enforces the user audience', async () => {
  const path = base + '/models/' + model;
  expect((await send(1, path, 'PUT', definition)).statusCode).toBe(403);
  expect((await send(0, path, 'PUT', definition)).statusCode).toBe(200);
  const metadata = {
    name: 'Chat fixture service',
    note: '',
    projectId: 'proj_chat_fixture',
    serviceAccountId: 'svc_acct_chat_fixture',
    limits: { daily: 2_000_000, monthly: 5_000_000 },
    concurrency: 2,
    priority: 10,
    allowedUsers: [ids[1]],
    models: [model],
    enabled: true,
  };
  const added = await send(0, base + '/accounts', 'POST', {
    ...metadata,
    apiKey: 'sk-fixture-chat-only-no-outbound',
    confirmServiceAccount: true,
  });
  expect(added.statusCode, added.body).toBe(200);
  const account = base + '/accounts/' + added.json().id;
  expect((await send(0, account + '/test', 'POST')).statusCode).toBe(200);
  const mock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/responses/input_tokens'))
      return Response.json({ input_tokens: 12 });
    expect(String(url)).toBe('https://api.openai.com/v1/models/' + model);
    return Response.json({ id: model, object: 'model' });
  });
  vi.stubGlobal('fetch', mock);
  await tick();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((await send(0, account, 'PATCH', metadata)).json()).toMatchObject({
    enabled: true,
  });
  const edited = await send(0, account, 'PATCH', {
    ...metadata,
    allowedUsers: undefined,
  });
  expect(edited.statusCode, edited.body).toBe(200);
  const records = (await send(0, base)).json().accounts;
  expect(
    records.find((r: any) => r.id === added.json().id).allowed_users,
  ).toEqual([ids[1]]);
  const config = (await send(0, base)).json().policy;
  expect(
    (
      await send(0, base + '/policy', 'PATCH', {
        ...config,
        enabled: true,
        globalDaily: 3_000_000,
        globalMonthly: 5_000_000,
        timeZone: 'Asia/Shanghai',
        defaultUser: { ...config.defaultUser, models: [model] },
      })
    ).statusCode,
  ).toBe(200);
  expect((await send(1, '/api/ai/platform')).json()).toMatchObject({
    models: [model],
    catalog: [{ id: model, label: definition.displayName, default: true }],
    codexRuntime: false,
  });
  expect((await send(2, '/api/ai/platform')).json()).toMatchObject({
    models: [],
  });
  denyNetwork();
});
it('persists user-scoped chat turns, deduplicates submissions, and supplies multi-turn context to Responses', async () => {
  const created = await send(1, '/api/ai/chats', 'POST', {
    title: 'fixture thread',
  });
  expect(created.statusCode, created.body).toBe(200);
  chatId = created.json().id;
  const chat = '/api/ai/chats/' + chatId;
  expect((await send(2, chat)).statusCode).toBe(404);
  expect((await send(2, chat, 'DELETE')).statusCode).toBe(404);
  const prompt = { model, prompt: 'first message', requestId: randomUUID() };
  const posted = await send(1, chat + '/messages', 'POST', prompt);
  expect(posted.statusCode, posted.body).toBe(200);
  expect((await send(1, chat + '/messages', 'POST', prompt)).json()).toEqual(
    posted.json(),
  );
  expect(
    (await send(2, '/api/ai/tasks/' + posted.json().id + '/cancel', 'POST'))
      .statusCode,
  ).toBe(404);
  const requests: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/responses/input_tokens'))
        return Response.json({ input_tokens: 15 });
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      requests.push(JSON.parse(String(init.body)));
      const events = [
        {
          type: 'response.output_text.delta',
          delta: 'fixture assistant answer',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_chat_fixture',
            usage: {
              input_tokens: 15,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 2, cache_write_tokens: 4 },
            },
          },
        },
      ];
      return new Response(
        events
          .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  await tick();
  const reply = await send(1, chat + '/messages', 'POST', {
    model,
    prompt: 'second message',
    requestId: randomUUID(),
  });
  expect(reply.statusCode, reply.body).toBe(200);
  await tick();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    model,
    store: false,
    input: [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'fixture assistant answer' },
      { role: 'user', content: 'second message' },
    ],
  });
  const regenerated = await send(1, chat + '/messages', 'POST', {
    model,
    retryOf: reply.json().id,
    requestId: randomUUID(),
  });
  expect(regenerated.statusCode, regenerated.body).toBe(200);
  await tick();
  expect(requests).toHaveLength(3);
  expect(requests[2].input).toEqual(requests[1].input);
  const thread = await send(1, chat);
  expect(thread.json().messages.map((m: any) => m.status)).toEqual([
    'COMPLETED',
    'COMPLETED',
    'COMPLETED',
  ]);
  expect((await send(1, '/api/ai/chats?q=second')).json()).toHaveLength(1);
  expect((await send(2, '/api/ai/chats?q=second')).json()).toEqual([]);
  const usage = await send(1, '/api/ai/platform/usage');
  expect(usage.json()[0]).toMatchObject({
    model,
    input_tokens: 15,
    cache_write_tokens: 4,
    output_tokens: 3,
  });
  expect((await send(2, '/api/ai/platform/usage')).json()).toEqual([]);
  denyNetwork();
});
it('disables the model immediately, protects attachments, and refuses native tasks without a runtime', async () => {
  const chat = '/api/ai/chats/' + chatId;
  expect(
    (
      await send(1, chat + '/messages', 'POST', {
        model,
        prompt: 'try file',
        requestId: randomUUID(),
        attachment: { name: 'test.txt', text: 'synthetic' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await send(1, '/api/ai/codex/tasks', 'POST', { model })).statusCode,
  ).toBe(503);
  expect(
    (
      await send(0, base + '/models/' + model, 'PUT', {
        ...definition,
        enabled: false,
        defaultChat: false,
      })
    ).statusCode,
  ).toBe(200);
  expect((await send(1, '/api/ai/platform')).json()).toMatchObject({
    models: [],
  });
  expect(
    (
      await send(1, chat + '/messages', 'POST', {
        model,
        prompt: 'blocked',
        requestId: randomUUID(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await send(1, chat, 'PATCH', { title: 'updated fixture title' }))
      .statusCode,
  ).toBe(200);
  expect((await send(1, chat, 'DELETE')).statusCode).toBe(200);
  expect((await send(1, chat)).statusCode).toBe(404);
});

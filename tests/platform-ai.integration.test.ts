import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/server';
import { createSession } from '../packages/auth/src';
import { sql } from '../packages/db/src';
import { tick } from '../apps/worker/src/jobs';
import { platformReserve } from '../packages/shared/src/platform-ai';

const ids = [randomUUID(), randomUUID(), randomUUID()];
const model = 'gpt-4.1-mini';
const sampleKey = 'sk-fixture-openai-never-send-outbound';
const base = '/api/admin/ai-platform';
const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;
let accountId: string;
let taskId: string;
let submittedBy = 1;
let configuredPolicy: any;
const send = (
  who: number,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
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
const noNetwork = () =>
  vi.fn(async () => {
    throw Error('Unexpected provider call');
  });
const reserve = platformReserve(model, 2000);

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.pathname.startsWith('/fafa_platform_') ||
    !url.pathname.endsWith('_test')
  )
    throw Error('Dedicated platform test database required');
  vi.stubEnv('PLATFORM_CODEX_ENABLED', 'true');
  vi.stubEnv('DEMO_MODE', 'false');
  vi.stubGlobal('fetch', noNetwork());
  app = await buildApp();
  for (let i = 0; i < ids.length; i++) {
    const [user] =
      await sql`insert into users(id,email,name,role,codex_tasks_enabled)
      values (${ids[i]},${ids[i] + '@example.invalid'},'platform fixture',${i === 0 ? 'Owner' : 'Member'},true) returning *`;
    sessions.push(await createSession(user as any));
  }
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (app) await sql`update users set deleted_at=now() where id in ${sql(ids)}`;
  await app?.close();
  await sql.end();
});

it('checks Owner permissions and encrypts newly registered service credentials', async () => {
  expect((await send(1, base)).statusCode).toBe(403);
  expect((await send(1, '/api/ai_accounts')).statusCode).toBe(403);
  const data = {
    name: 'Test Project Account',
    note: '',
    projectId: 'proj_fixture',
    serviceAccountId: 'svc_acct_fixture',
    apiKey: sampleKey,
    models: [model],
    limits: { daily: 5_000_000, monthly: 10_000_000 },
    concurrency: 2,
    enabled: false,
  };
  const path = base + '/accounts';
  expect((await send(0, path, 'POST', data)).statusCode).toBe(400);
  const added = await send(0, path, 'POST', {
    ...data,
    confirmServiceAccount: true,
  });
  expect(added.statusCode, added.body).toBe(200);
  accountId = added.json().id;
  const [row] =
    await sql`select secret from ai_platform_accounts where id=${accountId}`;
  expect(row.secret).toBeTruthy();
  expect(JSON.stringify(row.secret)).not.toContain(sampleKey);
  const result = await send(0, base);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().accounts[0]).not.toHaveProperty('secret');
  expect(result.body).not.toContain(sampleKey);
  configuredPolicy = {
    ...result.json().policy,
    enabled: true,
    globalMonthly: reserve + 1,
  };
});

it('checks configured models through the Worker and makes available service visible to a member', async () => {
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/responses/input_tokens'))
      return Response.json({ input_tokens: 12 });
    expect(String(url)).toBe('https://api.openai.com/v1/models/' + model);
    expect(new Headers(init.headers).get('openai-project')).toBe(
      'proj_fixture',
    );
    return Response.json({ id: model, object: 'model' });
  });
  vi.stubGlobal('fetch', mock);
  const path = base + '/accounts/' + accountId;
  expect((await send(0, path + '/test', 'POST')).json()).toMatchObject({
    health: 'CHECK_PENDING',
  });
  await tick();
  expect(mock).toHaveBeenCalledTimes(2);
  const edit = await send(0, path, 'PATCH', {
    name: 'Test Project Account',
    note: '',
    models: [model],
    enabled: true,
    limits: { daily: 5_000_000, monthly: 10_000_000 },
    concurrency: 2,
  });
  expect(edit.json()).toMatchObject({ enabled: true });
  expect(
    (await send(0, base + '/policy', 'PATCH', configuredPolicy)).statusCode,
  ).toBe(200);
  const service = await send(1, '/api/ai/platform');
  expect(service.statusCode, service.body).toBe(200);
  expect(service.json()).toMatchObject({ mode: true, models: [model] });
  expect(service.body).not.toContain(accountId);
  vi.stubGlobal('fetch', noNetwork());
});

it('does not accept account IDs from members and atomically reserves the shared budget', async () => {
  const route = '/api/ai/platform/tasks';
  const input = {
    model,
    prompt: 'synthetic integration task',
    workspace: 'org/example',
  };
  expect(
    (await send(1, route, 'POST', { ...input, accountId })).statusCode,
  ).toBe(400);
  expect(
    (await send(1, '/api/ai/tasks', 'POST', { ...input, accountId }))
      .statusCode,
  ).toBe(403);
  const results = await Promise.all([
    send(1, route, 'POST', input),
    send(2, route, 'POST', input),
  ]);
  expect(
    results.map((r) => r.statusCode).sort(),
    results.map((r) => r.body).join(' '),
  ).toEqual([200, 429]);
  submittedBy = results[0].statusCode === 200 ? 1 : 2;
  taskId = results[submittedBy - 1].json().id;
  const other = 3 - submittedBy;
  expect((await send(other, '/api/ai/tasks')).json()).toEqual([]);
  expect(
    (await send(other, '/api/ai/tasks/' + taskId + '/cancel', 'POST'))
      .statusCode,
  ).toBe(404);
  const own = await send(submittedBy, '/api/ai/tasks');
  expect(own.body).not.toContain(accountId);
  expect(own.json()[0]).toMatchObject({
    id: taskId,
    status: 'QUEUED',
    accountId: null,
  });
});

it('executes one scoped text request and settles upstream token usage exactly once', async () => {
  const usage = {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 50,
    total_tokens: 150,
  };
  const event = (data: object) => 'data: ' + JSON.stringify(data) + '\n\n';
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const headers = new Headers(init.headers);
    expect(headers.get('openai-project')).toBe('proj_fixture');
    expect(headers.get('authorization') === 'Bearer ' + sampleKey).toBe(true);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model,
      service_tier: 'default',
      store: false,
    });
    expect(body).not.toHaveProperty('tools');
    return new Response(
      event({ type: 'response.output_text.delta', delta: 'fixture reply' }) +
        event({
          type: 'response.completed',
          response: { id: 'resp_fixture', usage },
        }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  vi.stubGlobal('fetch', mock);
  await tick();
  await tick();
  expect(mock).toHaveBeenCalledTimes(1);
  const list = await send(submittedBy, '/api/ai/tasks');
  expect(list.json()[0]).toMatchObject({
    status: 'COMPLETED',
    output: 'fixture reply',
    usage,
  });
  const [settled] =
    await sql`select charged_micros,input_tokens,cached_tokens,output_tokens from ai_platform_usage where task_id=${taskId}`;
  expect({
    ...settled,
    charged_micros: Number(settled.charged_micros),
  }).toEqual({
    charged_micros: 114,
    input_tokens: 100,
    cached_tokens: 20,
    output_tokens: 50,
  });
  const summary = (await send(0, base)).json();
  expect(summary.usage).toMatchObject({
    charged: 114,
    input: 100,
    output: 50,
    unsettled: 0,
  });
  vi.stubGlobal('fetch', noNetwork());
});

it('halts a throttled project without retrying or shifting the request', async () => {
  configuredPolicy.globalMonthly = 5_000_000;
  expect(
    (await send(0, base + '/policy', 'PATCH', configuredPolicy)).statusCode,
  ).toBe(200);
  const task = await send(1, '/api/ai/platform/tasks', 'POST', {
    model,
    prompt: 'rate limit fixture',
  });
  expect(task.statusCode, task.body).toBe(200);
  const mock = vi.fn(async () =>
    Response.json(
      { error: { message: 'Fixture limit' } },
      {
        status: 429,
        headers: { 'Retry-After': '120' },
      },
    ),
  );
  vi.stubGlobal('fetch', mock);
  await tick();
  await tick();
  expect(mock).toHaveBeenCalledTimes(1);
  const [account] =
    await sql`select health,last_error from ai_platform_accounts where id=${accountId}`;
  expect(account).toEqual({ health: 'THROTTLED', last_error: 'HTTP_429' });
  const [blocked] =
    await sql`select (value #>> '{}')::timestamptz > now() as paused from settings
    where key='platform_ai_pause:proj_fixture'`;
  expect(blocked.paused).toBe(true);
  expect((await send(2, '/api/ai/platform')).json()).toMatchObject({
    models: [],
  });
  vi.stubGlobal('fetch', noNetwork());
});

it('applies per-user entitlement and revokes local credentials without exposing them', async () => {
  const quota = { ...configuredPolicy.defaultUser, enabled: false };
  expect(
    (await send(0, base + '/quota/' + ids[1], 'PATCH', quota)).statusCode,
  ).toBe(200);
  expect((await send(1, '/api/ai/platform')).json()).toMatchObject({
    models: [],
  });
  expect(
    (
      await send(1, '/api/ai/platform/tasks', 'POST', {
        model,
        prompt: 'blocked',
      })
    ).statusCode,
  ).toBe(403);
  const path = base + '/accounts/' + accountId + '/credential';
  expect((await send(0, path, 'POST', { action: 'revoke' })).statusCode).toBe(
    200,
  );
  expect((await send(2, '/api/ai/platform')).json()).toMatchObject({
    models: [],
  });
  const [account] =
    await sql`select secret,enabled,health from ai_platform_accounts where id=${accountId}`;
  expect(account).toEqual({ secret: null, enabled: false, health: 'REVOKED' });
});

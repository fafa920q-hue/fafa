import {
  defaultTrialPolicy,
  resolveAccess,
} from '../packages/auth/src/business-access';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '../packages/db/src';
import { createSession } from '../packages/auth/src';
import {
  applyAutoGrant,
  AUTO_GRANT_POLICY_KEYS,
} from '../packages/auth/src/auto-grant';
import {
  defaultServicePolicy,
  serviceOpen,
  servicePolicySchema,
} from '../packages/auth/src/service-policy';
import { seal } from '../packages/shared/src/crypto';
import { buildApp } from '../apps/api/src/server';
import { runAiTask } from '../apps/worker/src/jobs';

let app: Awaited<ReturnType<typeof buildApp>>;
const ids = [randomUUID(), randomUUID(), randomUUID()];
const accounts = [randomUUID(), randomUUID()];
const sessions: any[] = [];
let saved: any[];
const send = (who: number, url: string, method: any = 'GET', payload?: any) =>
  app.inject({
    method,
    url,
    headers: {
      origin: 'http://localhost:5173',
      cookie: 'fafa_session=' + sessions[who].raw,
      'x-csrf-token': sessions[who].csrf,
    },
    ...(payload ? { payload } : {}),
  });
const policy = (starts: number, ends: number) => ({
  ...defaultServicePolicy,
  schedule: {
    enabled: true,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
  },
});
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL!);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    !target.pathname.endsWith('_test')
  )
    throw Error('ISOLATED_DATABASE_REQUIRED');
  saved =
    await sql`SELECT key,value FROM settings WHERE key IN ${sql([...AUTO_GRANT_POLICY_KEYS, 'service_policy_v3'])}`;
  await sql`DELETE FROM settings WHERE key='service_policy_v3'`;
  app = await buildApp();
  for (let i = 0; i < ids.length; i++) {
    const [u] =
      await sql`INSERT INTO users(id,email,name,role,node_access_enabled,server_connect_enabled,codex_tasks_enabled) VALUES(${ids[i]},${randomUUID() + '@example.invalid'},'synthetic policy test',${i === 0 ? 'Owner' : 'Member'},true,true,true) RETURNING *`;
    sessions.push(await createSession(u as any));
  }
  for (let i = 0; i < accounts.length; i++)
    await sql`INSERT INTO ai_accounts(id,owner_id,data,secret) VALUES(${accounts[i]},${ids[i]},'{"provider":"OPENAI_API"}',${sql.json(seal('synthetic-key-no-outbound'))})`;
});
afterAll(async () => {
  await sql`DELETE FROM settings WHERE key IN ${sql(['service_policy_v3', 'registration_trial_v3', ...ids.map((id) => 'trial_entitlement_' + id), ...ids.map((id) => 'ai_quota_' + id)])}`;
  for (const row of saved)
    await sql`INSERT INTO settings(key,value) VALUES(${row.key},coalesce(${sql.json(row.value)},'null'::jsonb)) ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  await sql`UPDATE users SET deleted_at=now() WHERE id IN ${sql(ids)}`;
  await app.close();
  await sql.end();
  vi.unstubAllEnvs();
});
it('网页 ChatGPT 授权开关缺省关闭，打开后仍等待托管授权，API Key 模式独立可用', async () => {
  const route = '/api/ai/service';
  expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(
    401,
  );
  try {
    for (const [setting, expected] of [
      [undefined, 'DISABLED'],
      ['invalid', 'DISABLED'],
      ['true', 'AWAITING_PROVIDER_APPROVAL'],
    ] as const) {
      vi.stubEnv('CHATGPT_WEB_AUTH_ENABLED', setting);
      for (const who of [0, 1]) {
        const response = await send(who, route);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          personalCodex: 'UNAVAILABLE',
          chatgptAuthorization: expected,
          personalApi: 'AVAILABLE',
        });
      }
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
it('Claude 账户密文、默认配置、任务计费与流式执行按用户和提供商隔离', async () => {
  const provider = 'ANTHROPIC_API';
  const sampleKey = 'synthetic-claude-first-not-a-real-key';
  const payload = { provider, name: 'Claude 一', apiKey: sampleKey };
  vi.stubEnv('DEMO_MODE', 'false');
  vi.stubEnv('ANTHROPIC_API_ENABLED', 'false');
  try {
    expect(
      (await send(1, '/api/ai_accounts', 'POST', payload)).statusCode,
    ).toBe(503);
    vi.stubEnv('ANTHROPIC_API_ENABLED', 'true');
    vi.stubEnv(
      'ANTHROPIC_AUTH_TOKEN',
      'synthetic-environment-token-must-not-be-used',
    );
    const first = await send(1, '/api/ai_accounts', 'POST', payload);
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain(sampleKey);
    expect(first.json()).toMatchObject({
      provider,
      credentialConfigured: true,
    });
    const { id } = first.json();
    const [stored] =
      await sql`SELECT secret IS NULL AS legacy_empty, anthropic_secret IS NOT NULL AS configured FROM ai_accounts WHERE id=${id}`;
    expect(stored).toMatchObject({ legacy_empty: true, configured: true });
    const second = await send(1, '/api/ai_accounts', 'POST', {
      ...payload,
      name: 'Claude 二',
      apiKey: 'synthetic-claude-second-key',
    });
    expect(second.statusCode).toBe(200);
    const select = (who: number, accountId: string) =>
      send(who, '/api/ai/select', 'POST', { accountId });
    expect((await select(1, id)).statusCode).toBe(200);
    expect((await select(1, accounts[1])).statusCode).toBe(200);
    expect((await select(2, id)).statusCode).toBe(404);
    const list = await send(1, '/api/ai_accounts');
    expect(
      list.json().filter((a: { selected?: boolean }) => a.selected),
    ).toHaveLength(2);
    expect((await send(2, '/api/ai_accounts/' + id)).statusCode).toBe(404);
    expect(
      (
        await send(1, '/api/ai_accounts/' + id, 'PUT', {
          ...payload,
          provider: 'OPENAI_API',
        })
      ).statusCode,
    ).toBe(400);
    const taskPayload = {
      provider,
      accountId: id,
      prompt: 'stream fixture only',
    };
    expect(
      (await send(2, '/api/ai/tasks', 'POST', taskPayload)).statusCode,
    ).toBe(404);
    expect(
      (
        await send(1, '/api/ai/tasks', 'POST', {
          ...taskPayload,
          provider: 'OPENAI_API',
        })
      ).statusCode,
    ).toBe(400);
    const submitted = await send(1, '/api/ai/tasks', 'POST', taskPayload);
    expect(submitted.statusCode).toBe(200);
    expect((await select(1, second.json().id)).statusCode).toBe(200);
    const [running] =
      await sql`UPDATE ai_tasks SET data=data || '{"status":"RUNNING"}'::jsonb WHERE id=${submitted.json().id} RETURNING *`;
    const streamEvents = [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 3, output_tokens: 0 } },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Claude fixture reply' },
      },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer ' + sampleKey,
      );
      return new Response(
        streamEvents
          .map(
            (e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n',
          )
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', request);
    await runAiTask(running);
    expect(request).toHaveBeenCalledTimes(1);
    const [finished] =
      await sql`SELECT data FROM ai_tasks WHERE id=${running.id}`;
    expect(finished.data).toMatchObject({
      provider,
      status: 'COMPLETED',
      output: 'Claude fixture reply',
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    const pending = await send(1, '/api/ai/tasks', 'POST', {
      ...taskPayload,
      accountId: second.json().id,
    });
    expect(pending.statusCode).toBe(200);
    const [active] =
      await sql`UPDATE ai_tasks SET data=data || '{"status":"RUNNING"}'::jsonb WHERE id=${pending.json().id} RETURNING *`;
    let aborted = false;
    const stalled = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('cancelled', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', stalled);
    const activeWorker = runAiTask(active);
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledTimes(1));
    expect(
      (await send(1, '/api/ai/tasks/' + active.id + '/cancel', 'POST'))
        .statusCode,
    ).toBe(200);
    await activeWorker;
    expect(aborted).toBe(true);
    const failureCases = [
      [401, 'Claude API Key 无效或没有所选模型的访问权限'],
      [402, 'Claude API 账单或可用余额异常'],
      [429, 'Claude API 请求受到频率或额度限制'],
      [503, 'Claude API 暂时不可用'],
      [200, '请求失败，请检查 API Key、额度和模型权限'],
    ] as const;
    for (const [code, message] of failureCases) {
      const [fault] = await sql`INSERT INTO ai_tasks(owner_id,account_id,data)
        VALUES(${ids[1]},${id},${sql.json({ ...taskPayload, status: 'RUNNING' })}) RETURNING *`;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          code === 200
            ? new Response(
                streamEvents
                  .slice(0, -1)
                  .map(
                    (e) =>
                      'event: ' +
                      e.type +
                      '\ndata: ' +
                      JSON.stringify(e) +
                      '\n\n',
                  )
                  .join(''),
                { headers: { 'content-type': 'text/event-stream' } },
              )
            : Response.json(
                {
                  type: 'error',
                  error: { type: 'test_fixture', message: sampleKey },
                },
                { status: code },
              ),
        ),
      );
      await runAiTask(fault);
      const [failed] =
        await sql`SELECT data FROM ai_tasks WHERE id=${fault.id}`;
      expect(failed.data).toMatchObject({ status: 'FAILED', error: message });
      expect(JSON.stringify(failed.data)).not.toContain(sampleKey);
      await sql`DELETE FROM ai_tasks WHERE id=${fault.id}`;
    }
    const others = await send(2, '/api/ai/tasks');
    expect(others.json()).toEqual([]);
    expect(
      (await send(2, '/api/ai/tasks/' + running.id + '/cancel', 'POST'))
        .statusCode,
    ).toBe(404);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
it('服务窗口左闭右开、管理员可管理、禁用账户不可绕过，错误时间拒绝', () => {
  const p = policy(1000, 2000);
  expect(serviceOpen(p, { role: 'Member' }, 999)).toBe(false);
  expect(serviceOpen(p, { role: 'Member' }, 1000)).toBe(true);
  expect(serviceOpen(p, { role: 'Member' }, 2000)).toBe(false);
  expect(serviceOpen(p, { role: 'Owner' }, 2000)).toBe(true);
  expect(serviceOpen(p, { role: 'Owner', disabled: true }, 1500)).toBe(false);
  expect(servicePolicySchema.safeParse(policy(2000, 1000)).success).toBe(false);
});
it('仅Owner能配置全站时段，结束后阻止API和既有订阅令牌，恢复不改授权', async () => {
  const p = policy(Date.now() - 60000, Date.now() - 1000);
  expect(
    (await send(1, '/api/admin/service-policy', 'PATCH', p)).statusCode,
  ).toBe(403);
  const source = await send(0, '/api/node_sources', 'POST', {
    name: '服务时段夹具',
    kind: 'OWNED_NODE',
    authorized: true,
    content:
      'ss://' +
      Buffer.from('aes-256-gcm:window-fixture-only').toString('base64url') +
      '@window.example.invalid:443#window',
  });
  expect(source.statusCode).toBe(200);
  expect(
    (
      await send(0, '/api/admin/grants', 'POST', {
        kind: 'source',
        resourceId: source.json().id,
        userId: ids[1],
      })
    ).statusCode,
  ).toBe(200);
  const rotated = await send(1, '/api/subscription/rotate', 'POST', {});
  expect(rotated.statusCode).toBe(200);
  const path = new URL(rotated.json().url).pathname;
  expect(
    (await send(0, '/api/admin/service-policy', 'PATCH', p)).statusCode,
  ).toBe(200);
  expect((await send(1, '/api/ai/tasks')).json().code).toBe('SERVICE_CLOSED');
  expect((await app.inject(path)).json().code).toBe('SERVICE_CLOSED');
  expect((await send(0, '/api/admin/users')).statusCode).toBe(200);
  expect((await send(1, '/api/workspace')).statusCode).toBe(200);
  expect(
    (await send(0, '/api/admin/service-policy', 'PATCH', defaultServicePolicy))
      .statusCode,
  ).toBe(200);
  expect((await app.inject(path)).statusCode).toBe(200);
});
it('管理员AI服务只接受Owner本人账户，服务任务、个人额度与跨用户隔离生效', async () => {
  vi.stubEnv('DEMO_MODE', 'false');
  let p = {
    ...defaultServicePolicy,
    ai: { ...defaultServicePolicy.ai, enabled: true, accountId: accounts[1] },
  };
  expect(
    (await send(0, '/api/admin/service-policy', 'PATCH', p)).statusCode,
  ).toBe(400);
  p = { ...p, ai: { ...p.ai, accountId: accounts[0] } };
  expect(
    (await send(0, '/api/admin/service-policy', 'PATCH', p)).statusCode,
  ).toBe(200);
  expect(
    (
      await send(1, '/api/ai/tasks', 'POST', {
        accountId: accounts[0],
        prompt: 'synthetic',
      })
    ).statusCode,
  ).toBe(404);
  const task = await send(1, '/api/ai/tasks', 'POST', {
    service: true,
    prompt: 'synthetic',
  });
  expect(task.statusCode).toBe(200);
  expect((await send(2, '/api/ai/tasks')).body).not.toContain(task.json().id);
  expect(
    (await send(2, '/api/ai/tasks/' + task.json().id + '/cancel', 'POST', {}))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await send(1, '/api/admin/users/' + ids[1] + '/ai-quota', 'PATCH', {
        dailyLimit: 0,
        concurrency: 1,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await send(0, '/api/admin/users/' + ids[1] + '/ai-quota', 'PATCH', {
        dailyLimit: 0,
        concurrency: 1,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await send(1, '/api/ai/tasks', 'POST', {
        service: true,
        prompt: 'synthetic',
      })
    ).statusCode,
  ).toBe(429);
  await send(0, '/api/admin/service-policy', 'PATCH', defaultServicePolicy);
  expect(
    (
      await send(1, '/api/ai/tasks', 'POST', {
        service: true,
        prompt: 'synthetic',
      })
    ).json().code,
  ).toBe('AI_SERVICE_CLOSED');
  const outbound = vi.fn(() => {
    throw Error('NO_OUTBOUND_ALLOWED');
  });
  vi.stubGlobal('fetch', outbound);
  const [queued] =
    await sql`UPDATE ai_tasks SET data=data || '{"status":"RUNNING"}'::jsonb WHERE id=${task.json().id} RETURNING *`;
  await runAiTask(queued);
  expect(outbound).not.toHaveBeenCalled();
  const [finished] =
    await sql`SELECT data FROM ai_tasks WHERE id=${task.json().id}`;
  expect(finished.data.status).toBe('FAILED');
  vi.unstubAllGlobals();
});
it('自助注册仅在显式启用的注册窗口内获得体验，补发不延长或覆盖永久授权', async () => {
  vi.stubEnv('MEMBER_SELF_SERVICE', 'true');
  const start = new Date(Date.now() - 60000).toISOString();
  const end = new Date(Date.now() + 60000).toISOString();
  await sql`INSERT INTO google_identities(user_id,sub) VALUES(${ids[2]},${'verified-test-' + ids[2]})`;
  const save = await send(0, '/api/admin/access/trial-policy', 'PATCH', {
    ...defaultTrialPolicy,
    enabled: true,
    windowStart: start,
    windowEnd: end,
    durationHours: 24,
    registrationMethod: 'google',
  });
  expect(save.statusCode).toBe(200);
  await sql`UPDATE users SET node_access_enabled=false,server_connect_enabled=false,codex_tasks_enabled=false WHERE id=${ids[2]}`;
  const first = await sql.begin((tx) => applyAutoGrant(ids[2], tx));
  expect(first.applied).toBe(true);
  expect(await sql.begin((tx) => applyAutoGrant(ids[2], tx))).toMatchObject({
    applied: false,
    reason: 'ALREADY_PROCESSED',
  });
  const [user] = await sql`SELECT * FROM users WHERE id=${ids[2]}`;
  expect(user.node_access_until).toBeNull();
  const current = await resolveAccess(user);
  expect(current._access.capabilities.node).toBe(true);
  expect(Date.parse(current._access.overlays[0].endsAt)).toBe(
    new Date(user.created_at).getTime() + 86400000,
  );
  expect(await sql.begin((tx) => applyAutoGrant(ids[1], tx))).toMatchObject({
    applied: false,
    reason: 'AUDIENCE_NOT_ELIGIBLE',
  });
  const [manual] =
    await sql`SELECT node_access_until FROM users WHERE id=${ids[1]}`;
  expect(manual.node_access_until).toBeNull();
});

it('AI 后台只返回必要元数据，强停按角色授权并原子写入审计', async () => {
  const hidden = 'synthetic-private-prompt-and-error';
  const create = async (who: number, status: string) => {
    const [r] = await sql`INSERT INTO ai_tasks(owner_id,account_id,data) VALUES(
      ${ids[who]},${accounts[who]},${sql.json({ provider: 'OPENAI_API', prompt: hidden, output: hidden, error: hidden, status })}) RETURNING id`;
    return r.id;
  };
  const protectedId = await create(0, 'RUNNING');
  const memberId = await create(1, 'RUNNING');
  const queued = await create(1, 'QUEUED');
  const route = '/api/admin/ai-tasks';
  expect((await send(1, route)).statusCode).toBe(403);
  await sql`UPDATE users SET role='Admin' WHERE id=${ids[2]}`;
  try {
    const listed = await send(2, route);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(hidden);
    expect(listed.body).not.toContain('anthropic_secret');
    expect(listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: memberId,
          ownerId: ids[1],
          accountId: accounts[1],
          status: 'RUNNING',
        }),
      ]),
    );
    const stop = (who: number, target: string, id: string) =>
      send(who, route + '/cancel', 'POST', { target, id });
    expect((await stop(2, 'task', protectedId)).statusCode).toBe(404);
    expect((await stop(1, 'task', memberId)).statusCode).toBe(403);
    expect((await stop(2, 'task', memberId)).json()).toEqual({ cancelled: 1 });
    expect((await stop(0, 'owner', ids[1])).json()).toEqual({ cancelled: 1 });
    const actions =
      await sql`SELECT owner_id,action,target_id FROM audit_events WHERE target_id IN (${memberId},${queued})`;
    expect(actions).toEqual(
      expect.arrayContaining([
        {
          owner_id: ids[2],
          action: 'ai.admin_task_cancelled',
          target_id: memberId,
        },
        {
          owner_id: ids[0],
          action: 'ai.admin_owner_tasks_cancelled',
          target_id: queued,
        },
      ]),
    );
    await stop(0, 'task', protectedId);
  } finally {
    await sql`UPDATE users SET role='Member' WHERE id=${ids[2]}`;
  }
});

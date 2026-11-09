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

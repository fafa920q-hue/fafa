import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '../packages/db/src';
import { buildApp } from '../apps/api/src/server';
import { activateGoogle } from '../packages/auth/src';
import { loginMember } from '../packages/auth/src/member';
import { applyAutoGrant } from '../packages/auth/src/auto-grant';
let app: Awaited<ReturnType<typeof buildApp>>;
let savedSettings: any[] = [];
const created: string[] = [];
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
    throw Error('ISOLATED_DATABASE_REQUIRED');
  vi.stubEnv('MEMBER_SELF_SERVICE', 'true');
  vi.stubEnv('MAIL_PROVIDER', 'resend');
  vi.stubEnv('MAIL_API_KEY', 'synthetic-self-service-not-real');
  vi.stubEnv('MAIL_FROM', 'accounts@example.invalid');
  app = await buildApp();
  savedSettings = await sql.unsafe(
    "SELECT key,value FROM settings WHERE key IN ('member_registration_open','seat_limit')",
  );
  await sql.unsafe(
    "UPDATE settings SET value='true' WHERE key='member_registration_open'",
  );
  await sql.unsafe("UPDATE settings SET value='1000' WHERE key='seat_limit'");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const row of savedSettings)
    await sql.unsafe('UPDATE settings SET value=$1::jsonb WHERE key=$2', [
      JSON.stringify(row.value),
      row.key,
    ]);
  if (created.length) {
    await sql`update sessions set revoked_at=now() where owner_id in ${sql(created)}`;
    await sql`update users set deleted_at=now() where id in ${sql(created)}`;
  }
  await app.close();
  await sql.end();
  vi.unstubAllEnvs();
});
async function post(path: string, payload: any) {
  const config = await app.inject('/auth/member/config');
  const cookie = config.cookies.find((item) =>
    item.name.endsWith('fafa_member_csrf'),
  )!;
  return app.inject({
    method: 'POST',
    url: path,
    payload,
    headers: {
      origin: 'http://localhost:5173',
      cookie: cookie.name + '=' + cookie.value,
      'x-csrf-token': config.json().csrf,
    },
  });
}
it('自行注册仍须邮箱验证码，用户名和邮箱均可登录，不附带试用或其他用户的资源', async () => {
  const username = 'self_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const email = username + '@example.invalid';
  const password = 'synthetic-self-service-password-中文';
  let code = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: any) => {
      const mail = JSON.parse(options.body);
      if (mail.subject.includes('注册验证码'))
        code = mail.text.match(/验证码：(\d{6})/)[1];
      return new Response('{}', { status: 200 });
    }),
  );
  const start = await post('/auth/member/registration/start', {
    username,
    email,
    password,
    confirmPassword: password,
  });
  expect(start.statusCode).toBe(202);
  const verified = await post('/auth/member/registration/complete', {
    challenge: start.json().challenge,
    code,
    password,
  });
  expect(verified.statusCode).toBe(200);
  const named = await loginMember(username, password);
  created.push(named.user.id);
  const mailed = await loginMember(email, password);
  expect(named.user.id).toBe(mailed.user.id);
  expect(named.user.role).toBe('Member');
  const grant = await applyAutoGrant(named.user.id);
  expect(grant).toEqual({ applied: false, reason: 'OUTSIDE_WINDOW' });
  const [user] = await sql.unsafe(
    'SELECT node_access_enabled,server_connect_enabled,codex_tasks_enabled FROM users WHERE id=$1',
    [named.user.id],
  );
  expect(user).toMatchObject({
    node_access_enabled: false,
    server_connect_enabled: false,
    codex_tasks_enabled: false,
  });
  expect(
    (
      await sql.unsafe('SELECT id FROM auto_grant_records WHERE user_id=$1', [
        named.user.id,
      ])
    ).length,
  ).toBe(0);
});
it('新Google用户不需要邀请，历史Admin邀请也不能提升自行注册的权限；已有身份不改绑', async () => {
  const sub = 'self-service-' + randomUUID();
  const email = randomUUID() + '@example.invalid';
  const sponsor = await activateGoogle({
    sub: sub + '-sponsor',
    email: randomUUID() + '@example.invalid',
    email_verified: true,
  });
  created.push(sponsor.id);
  await sql`insert into invitations(owner_id,data) values(${sponsor.id},${sql.json({ email, role: 'Admin', expiresAt: new Date(Date.now() + 86400000).toISOString() })})`;
  const user = await activateGoogle({ sub, email, email_verified: true });
  created.push(user.id);
  expect(user.role).toBe('Member');
  expect((await activateGoogle({ sub, email, email_verified: true })).id).toBe(
    user.id,
  );
  expect(
    (
      await sql.unsafe('SELECT id FROM auto_grant_records WHERE user_id=$1', [
        user.id,
      ])
    ).length,
  ).toBe(0);
});

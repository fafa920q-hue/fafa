import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { buildApp } from '../apps/api/src/server';
import { sql } from '../packages/db/src';
import {
  createSession,
  activateGoogle,
  authenticate,
} from '../packages/auth/src';
import {
  issueOwnerCredential,
  beginOwnerCredential,
  completeOwnerCredential,
} from '../packages/auth/src/owner';
import { hash, token, unseal } from '../packages/shared/src/crypto';
import { settleAccountMail } from '../packages/auth/src/member-mail';

const origin = 'http://localhost:5173';
const password = 'synthetic-password-仅供隔离测试';
const changedPassword = 'synthetic-new-password-仅供测试';
const outbox: { to: string[]; subject: string; text: string }[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: any;
let ownerSession: Awaited<ReturnType<typeof createSession>>;
const publicPost = async (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const config = await app.inject('/auth/member/config');
  const csrf = config.json().csrf;
  const cookie = config.cookies.find((item) =>
    item.name.endsWith('fafa_member_csrf'),
  )!;
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: {
      origin,
      cookie: cookie.name + '=' + cookie.value,
      'x-csrf-token': csrf,
      ...headers,
    },
  });
};
const privateRequest = (
  session: any,
  url: string,
  method: any = 'GET',
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: {
      origin,
      cookie: 'fafa_session=' + session.raw,
      'x-csrf-token': session.csrf,
    },
  });
function mailToken(email: string, purpose: 'VERIFY' | 'RESET') {
  const message = outbox
    .filter(
      (mail) =>
        mail.to[0] === email &&
        mail.subject.includes(purpose === 'VERIFY' ? '激活' : '重置'),
    )
    .at(-1)!;
  const link = message.text
    .split('\n')
    .find((line) => line.startsWith('http'))!;
  const url = new URL(link);
  expect(url.search).toBe('');
  return new URLSearchParams(url.hash.slice(1)).get('token')!;
}
async function signup(suffix = randomUUID().replaceAll('-', '').slice(0, 8)) {
  const username = 'member_' + suffix;
  const email = username + '@example.invalid';
  const response = await publicPost('/auth/member/register', {
    username,
    email,
    password,
  });
  expect(response.statusCode).toBe(202);
  await settleAccountMail();
  return { username, email, raw: mailToken(email, 'VERIFY') };
}
async function activate() {
  const account = await signup();
  expect(
    (await publicPost('/auth/member/verify', { token: account.raw, password }))
      .statusCode,
  ).toBe(200);
  const login = await publicPost('/auth/member/login', {
    identifier: account.username,
    password,
  });
  expect(login.statusCode).toBe(200);
  const raw = login.cookies.find((item) => item.name === 'fafa_session')!.value;
  return {
    ...account,
    id: login.json().user.id,
    session: { raw, csrf: login.json().csrf },
  };
}
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/fafa_member_'))
    throw Error('隔离数据库必需');
  vi.stubEnv('MAIL_PROVIDER', 'resend');
  vi.stubEnv('MAIL_API_KEY', 'synthetic-mail-provider-fixture');
  vi.stubEnv('MAIL_FROM', 'accounts@example.invalid');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-google-fixture');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: any) => {
      expect(url).toBe('https://api.resend.com/emails');
      outbox.push(JSON.parse(options.body));
      return new Response('{}', { status: 200 });
    }),
  );
  app = await buildApp();
  const credential = await issueOwnerCredential();
  const state = token();
  const id = await beginOwnerCredential(credential, state);
  owner = await completeOwnerCredential(id, state, {
    sub: 'synthetic-bound-owner',
    email: 'owner@example.invalid',
    email_verified: true,
    name: 'Owner fixture',
  });
  ownerSession = await createSession(owner);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app.close();
  await sql.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('普通账户真实数据库和 API 安全边界', () => {
  it('默认关闭，缺邮件服务不能开启或谎报发送；Owner 绑定不变', async () => {
    const closed = await publicPost('/auth/member/register', {
      username: 'member_closed',
      email: 'closed@example.invalid',
      password,
    });
    expect(closed.statusCode).toBe(403);
    vi.stubEnv('MAIL_API_KEY', '');
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/member-registration',
          'PATCH',
          { enabled: true, seatLimit: 100 },
        )
      ).statusCode,
    ).toBe(503);
    expect(
      (await publicPost('/auth/member/forgot-password', { email: owner.email }))
        .statusCode,
    ).toBe(503);
    expect(outbox).toHaveLength(0);
    const [binding] = await sql.unsafe(
      'SELECT owner_id,google_sub,closed FROM owner_initialization WHERE singleton',
    );
    expect(binding).toMatchObject({
      owner_id: owner.id,
      google_sub: 'synthetic-bound-owner',
      closed: true,
    });
    vi.stubEnv('MAIL_API_KEY', 'synthetic-mail-provider-fixture');
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/member-registration',
          'PATCH',
          { enabled: true, seatLimit: 100 },
        )
      ).statusCode,
    ).toBe(200);
  });
  it('未认证注册和登录保留 Origin、CSRF，注册不能注入角色', async () => {
    expect(
      (
        await publicPost('/auth/member/register', {
          username: 'role_inject',
          email: 'role@example.invalid',
          password,
          role: 'Owner',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await publicPost(
          '/auth/member/login',
          { identifier: 'nobody', password },
          { origin: 'https://evil.invalid' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/member/login',
          payload: { identifier: 'nobody', password },
          headers: { origin },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('注册仅创建待验证申请，哈希入库，不按邮件预取激活；单次激活为 Member', async () => {
    const account = await signup();
    const pending = await sql.unsafe(
      'SELECT * FROM member_registrations WHERE email_key=$1',
      [account.email],
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].token_hash).toBe(hash(account.raw));
    expect(JSON.stringify(pending)).not.toContain(account.raw);
    expect(JSON.stringify(pending)).not.toContain(password);
    expect(
      await sql.unsafe('SELECT id FROM users WHERE email=$1', [account.email]),
    ).toHaveLength(0);
    expect(
      (
        await publicPost('/auth/member/login', {
          identifier: account.username,
          password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject('/auth/member/verify?token=' + account.raw)).statusCode,
    ).toBe(404);
    expect(
      (
        await publicPost('/auth/member/verify', {
          token: account.raw,
          password: 'incorrect synthetic password',
        })
      ).statusCode,
    ).toBe(400);
    const results = await Promise.all([
      publicPost('/auth/member/verify', { token: account.raw, password }),
      publicPost('/auth/member/verify', { token: account.raw, password }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      200, 400,
    ]);
    const [user] = await sql.unsafe('SELECT * FROM users WHERE email=$1', [
      account.email,
    ]);
    expect(user.role).toBe('Member');
    expect(
      (
        await publicPost('/auth/member/verify', {
          token: account.raw,
          password,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('用户名/邮箱登录、会话轮换、安全退出和跨用户撤销隔离', async () => {
    const account = await activate();
    const second = await publicPost('/auth/member/login', {
      identifier: account.email.toUpperCase(),
      password,
    });
    expect(second.statusCode).toBe(200);
    const secondRaw = second.cookies.find(
      (item) => item.name === 'fafa_session',
    )!.value;
    expect(secondRaw).not.toBe(account.session.raw);
    const sessions = await privateRequest(
      account.session,
      '/api/member/sessions',
    );
    expect(sessions.json()).toHaveLength(2);
    expect(sessions.body).not.toContain(secondRaw);
    expect(sessions.body).not.toContain(account.session.csrf);
    const [ownerDbSession] = await sql.unsafe(
      'SELECT id FROM sessions WHERE token_hash=$1',
      [hash(ownerSession.raw)],
    );
    expect(
      (
        await privateRequest(
          account.session,
          '/api/member/sessions/' + ownerDbSession.id,
          'DELETE',
        )
      ).statusCode,
    ).toBe(404);
    const other = sessions.json().find((session: any) => !session.current);
    expect(
      (
        await privateRequest(
          account.session,
          '/api/member/sessions/' + other.id,
          'DELETE',
        )
      ).statusCode,
    ).toBe(200);
    expect(await authenticate(secondRaw)).toBeNull();
    expect(
      (await privateRequest(account.session, '/api/admin/users')).statusCode,
    ).toBe(403);
    expect(
      (
        await privateRequest(
          account.session,
          '/api/admin/member-registration',
          'PATCH',
          { enabled: true, seatLimit: 200 },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await privateRequest(account.session, '/api/logout', 'POST')).statusCode,
    ).toBe(200);
    expect(await authenticate(account.session.raw)).toBeNull();
  });
  it('重复邮箱/用户名和不存在的找回请求返回统一响应，不暴露凭据', async () => {
    const account = await activate();
    const existing = await publicPost('/auth/member/register', {
      username: account.username,
      email: account.email,
      password,
    });
    const pending = await publicPost('/auth/member/register', {
      username: 'another_' + randomUUID().replaceAll('-', '').slice(0, 6),
      email: 'new_' + token() + '@example.invalid',
      password,
    });
    expect(existing.statusCode).toBe(202);
    expect(existing.body).toBe(pending.body);
    const first = await publicPost('/auth/member/forgot-password', {
      email: account.email,
    });
    const absent = await publicPost('/auth/member/forgot-password', {
      email: 'absent@example.invalid',
    });
    expect(first.statusCode).toBe(202);
    expect(first.body).toBe(absent.body);
    await settleAccountMail();
    const me = await privateRequest(account.session, '/api/member/profile');
    expect(me.json()).toMatchObject({
      username: account.username,
      emailVerified: true,
      googleLinked: false,
    });
    expect(me.body).not.toContain(password);
    expect(me.body).not.toContain('password_hash');
  });
  it('重发撤销旧激活令牌，过期和用过的令牌被拒绝', async () => {
    const account = await signup();
    await publicPost('/auth/member/resend-verification', {
      email: account.email,
      password,
    });
    await settleAccountMail();
    const fresh = mailToken(account.email, 'VERIFY');
    expect(fresh).not.toBe(account.raw);
    expect(
      (
        await publicPost('/auth/member/verify', {
          token: account.raw,
          password,
        })
      ).statusCode,
    ).toBe(400);
    await sql.unsafe(
      "UPDATE member_registrations SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [hash(fresh)],
    );
    expect(
      (await publicPost('/auth/member/verify', { token: fresh, password }))
        .statusCode,
    ).toBe(400);
  });
  it('找回令牌仅存哈希、限时单次使用，重置撤销全部会话与旧密码', async () => {
    const account = await activate();
    expect(
      (
        await publicPost('/auth/member/forgot-password', {
          email: account.email,
        })
      ).statusCode,
    ).toBe(202);
    await settleAccountMail();
    const raw = mailToken(account.email, 'RESET');
    const [stored] = await sql.unsafe(
      'SELECT * FROM member_action_tokens WHERE token_hash=$1',
      [hash(raw)],
    );
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(
      (
        await publicPost('/auth/member/reset-password', {
          token: raw,
          password: changedPassword,
        })
      ).statusCode,
    ).toBe(200);
    expect(await authenticate(account.session.raw)).toBeNull();
    expect(
      (
        await publicPost('/auth/member/login', {
          identifier: account.email,
          password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await publicPost('/auth/member/login', {
          identifier: account.username,
          password: changedPassword,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await publicPost('/auth/member/reset-password', {
          token: raw,
          password,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('管理员停用/撤销使会话和待用重置令牌失效，重新启用不恢复旧会话', async () => {
    const account = await activate();
    await publicPost('/auth/member/forgot-password', { email: account.email });
    await settleAccountMail();
    const raw = mailToken(account.email, 'RESET');
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/users/' + account.id,
          'PATCH',
          { disabled: true },
        )
      ).statusCode,
    ).toBe(200);
    expect(await authenticate(account.session.raw)).toBeNull();
    expect(
      (
        await publicPost('/auth/member/login', {
          identifier: account.email,
          password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await publicPost('/auth/member/reset-password', {
          token: raw,
          password: changedPassword,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/users/' + account.id,
          'PATCH',
          { disabled: false },
        )
      ).statusCode,
    ).toBe(200);
    expect(await authenticate(account.session.raw)).toBeNull();
  });
  it('Google 不按邮箱自动合并，绑定必须密码、原会话和正式 OIDC 校验', async () => {
    const account = await activate();
    await expect(
      activateGoogle({
        sub: 'attacker-sub',
        email: account.email,
        email_verified: true,
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_LINK_REQUIRED' });
    expect(
      (
        await privateRequest(
          account.session,
          '/api/member/google/start',
          'POST',
          { password: 'incorrect synthetic password' },
        )
      ).statusCode,
    ).toBe(401);
    const start = await privateRequest(
      account.session,
      '/api/member/google/start',
      'POST',
      { password },
    );
    expect(start.statusCode).toBe(200);
    const oidc = start.cookies.find((cookie) => cookie.name === 'fafa_oidc')!;
    const flow = JSON.parse(
      unseal(JSON.parse(Buffer.from(oidc.value, 'base64url').toString())),
    );
    const exchange = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockResolvedValue({ tokens: { id_token: 'synthetic-token' } } as any);
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    const payload = {
      sub: 'member-sub-' + randomUUID(),
      email: account.email,
      email_verified: true,
      iss: 'https://accounts.google.com',
      aud: process.env.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: flow.nonce,
    };
    verify.mockResolvedValue({ getPayload: () => payload } as any);
    const callback = (raw = account.session.raw, state = flow.state) =>
      app.inject({
        url: '/auth/google/callback?state=' + state + '&code=synthetic',
        headers: {
          cookie: 'fafa_oidc=' + oidc.value + '; fafa_session=' + raw,
        },
      });
    expect((await callback(account.session.raw, 'wrong')).statusCode).toBe(403);
    expect(exchange).not.toHaveBeenCalled();
    expect((await callback(ownerSession.raw)).statusCode).toBe(403);
    for (const bad of [
      { nonce: 'wrong' },
      { aud: 'wrong' },
      { iss: 'https://evil.invalid' },
      { exp: 1 },
    ]) {
      verify.mockResolvedValue({
        getPayload: () => ({ ...payload, ...bad }),
      } as any);
      expect((await callback()).statusCode).toBe(403);
    }
    verify.mockResolvedValue({ getPayload: () => payload } as any);
    const bound = await callback();
    expect(bound.statusCode).toBe(302);
    expect(bound.headers.location).toBe(origin + '/member/account');
    expect(await authenticate(account.session.raw)).toBeNull();
    expect((await callback()).statusCode).toBe(403);
    const googleUser = await activateGoogle(payload);
    expect(googleUser.id).toBe(account.id);
    expect(googleUser.role).toBe('Member');
    expect(
      (
        await privateRequest(ownerSession, '/api/member/google/start', 'POST', {
          password,
        })
      ).statusCode,
    ).toBe(403);
    const preserved = await activateGoogle({
      sub: 'synthetic-bound-owner',
      email: owner.email,
      email_verified: true,
    });
    expect(preserved.id).toBe(owner.id);
    expect(preserved.role).toBe('Owner');
  });
  it('席位限制在激活事务内重查；新 Google 自由注册也只能 Member', async () => {
    const account = await signup();
    const [count] = await sql.unsafe(
      'SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL',
    );
    await privateRequest(
      ownerSession,
      '/api/admin/member-registration',
      'PATCH',
      { enabled: true, seatLimit: count.total },
    );
    expect(
      (
        await publicPost('/auth/member/verify', {
          token: account.raw,
          password,
        })
      ).statusCode,
    ).toBe(409);
    await privateRequest(
      ownerSession,
      '/api/admin/member-registration',
      'PATCH',
      { enabled: true, seatLimit: 100 },
    );
    const googleUser = await activateGoogle({
      sub: 'free-google-' + token(),
      email: 'free-google@example.invalid',
      email_verified: true,
    });
    expect(googleUser.role).toBe('Member');
  });
  it('邮件提供商失败记录脱敏审计并撤销未投递令牌，不假报已发送', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('synthetic provider failure', { status: 503 }),
      ),
    );
    const email = 'failed-delivery@example.invalid';
    const response = await publicPost('/auth/member/register', {
      username: 'failed_delivery',
      email,
      password,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().message).toContain('尝试');
    await settleAccountMail();
    const [pending] = await sql.unsafe(
      'SELECT consumed_at FROM member_registrations WHERE email_key=$1',
      [email],
    );
    expect(pending.consumed_at).not.toBeNull();
    const [failure] = await sql.unsafe(
      "SELECT * FROM audit_events WHERE action='member.mail_failed' ORDER BY created_at DESC LIMIT 1",
    );
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain(email);
  });
  it('标识符限流不依赖账户存在性，且匿名配置不返回秘密', async () => {
    let status = 0;
    for (let attempt = 0; attempt < 11; attempt++)
      status = (
        await publicPost('/auth/member/login', {
          identifier: 'rate_limit_absent',
          password,
        })
      ).statusCode;
    expect(status).toBe(429);
    const config = await app.inject('/auth/member/config');
    expect(config.body).not.toContain(process.env.MAIL_API_KEY!);
    expect(config.body).not.toContain(process.env.GOOGLE_CLIENT_SECRET!);
    const [ownerCount] = await sql.unsafe(
      "SELECT count(*)::int AS total FROM users WHERE role='Owner'",
    );
    expect(ownerCount.total).toBe(1);
  });
});

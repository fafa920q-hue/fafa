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
import { loginMember } from '../packages/auth/src/member';

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
        mail.subject.includes(purpose === 'VERIFY' ? '激活' : '重置') &&
        mail.text.split('\n').some((line) => line.startsWith('http')),
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
    const staleProof = await loginMember(account.email, password);
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
    await expect(
      createSession(staleProof.user, staleProof.passwordHash),
    ).rejects.toMatchObject({ code: 'LOGIN_INVALID' });
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

describe('验证码、真实API邮件状态和限时授权集成', () => {
  function provider() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: any) => {
        expect(url).toBe('https://api.resend.com/emails');
        outbox.push(JSON.parse(options.body));
        return new Response('{}', { status: 200 });
      }),
    );
  }
  let client = 50;
  async function post(url: string, payload: Record<string, unknown>) {
    const config = await app.inject('/auth/member/config'),
      cookie = config.cookies.find((c) => c.name.endsWith('fafa_member_csrf'))!;
    return app.inject({
      method: 'POST',
      url,
      payload,
      remoteAddress: '192.0.2.' + client,
      headers: {
        origin,
        cookie: cookie.name + '=' + cookie.value,
        'x-csrf-token': config.json().csrf,
      },
    });
  }
  function codeFor(email: string) {
    const text = outbox
      .filter((m) => m.to[0] === email && m.subject.includes('注册验证码'))
      .at(-1)!.text;
    return text.match(/验证码：(\d{6})/)![1];
  }
  async function start() {
    client++;
    provider();
    await privateRequest(
      ownerSession,
      '/api/admin/member-registration',
      'PATCH',
      { enabled: true, seatLimit: 1000 },
    );
    const username = 'otp_' + randomUUID().replaceAll('-', '').slice(0, 12),
      email = username + '@example.invalid';
    const response = await post('/auth/member/registration/start', {
      username,
      email,
      password,
      confirmPassword: password,
    });
    expect(response.statusCode).toBe(202);
    return {
      username,
      email,
      challenge: response.json().challenge,
      code: codeFor(email),
    };
  }
  async function finish(account: any) {
    const response = await post('/auth/member/registration/complete', {
      challenge: account.challenge,
      code: account.code,
      password,
    });
    expect(response.statusCode).toBe(200);
    return {
      id: response.json().user.id,
      raw: response.cookies.find((c) => c.name === 'fafa_session')!.value,
      csrf: response.json().csrf,
    };
  }
  it('真实验证码请求、哈希、未激活禁止登录、一次激活并建立Member会话及成功通知', async () => {
    const account = await start();
    const [pending] = await sql.unsafe(
      'SELECT * FROM member_registrations WHERE challenge_hash=$1',
      [hash(account.challenge)],
    );
    expect(pending.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.code_hash).not.toBe(hash(account.code));
    expect(JSON.stringify(pending)).not.toContain(account.challenge);
    expect(
      (
        await post('/auth/member/login', {
          identifier: account.username,
          password,
        })
      ).statusCode,
    ).toBe(401);
    const session = await finish(account);
    expect((await privateRequest(session, '/api/me')).json().user.role).toBe(
      'Member',
    );
    expect(
      (await privateRequest(session, '/api/admin/member-mail')).statusCode,
    ).toBe(403);
    expect(
      (
        await post('/auth/member/registration/complete', {
          challenge: account.challenge,
          code: account.code,
          password,
        })
      ).statusCode,
    ).toBe(400);
    await settleAccountMail();
    expect(
      outbox.some(
        (m) => m.to[0] === account.email && m.subject.includes('验证成功'),
      ),
    ).toBe(true);
    const events = await sql.unsafe(
      'SELECT purpose,status FROM member_mail_events WHERE owner_id=$1',
      [session.id],
    );
    expect(
      events.some((x) => x.purpose === 'VERIFIED' && x.status === 'ACCEPTED'),
    ).toBe(true);
  });
  it('错误次数持久化且五次后锁定；过期验证码明确拒绝', async () => {
    const account = await start(),
      bad = account.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post('/auth/member/registration/complete', {
            challenge: account.challenge,
            code: bad,
            password,
          })
        ).json().code,
      ).toBe('CODE_INVALID');
    expect(
      (
        await post('/auth/member/registration/complete', {
          challenge: account.challenge,
          code: account.code,
          password,
        })
      ).json().code,
    ).toBe('CODE_LOCKED');
    const [row] = await sql.unsafe(
      'SELECT code_attempts FROM member_registrations WHERE challenge_hash=$1',
      [hash(account.challenge)],
    );
    expect(row.code_attempts).toBe(5);
    const expired = await start();
    await sql.unsafe(
      "UPDATE member_registrations SET code_expires_at=now()-interval '1 second' WHERE challenge_hash=$1",
      [hash(expired.challenge)],
    );
    expect(
      (
        await post('/auth/member/registration/complete', {
          challenge: expired.challenge,
          code: expired.code,
          password,
        })
      ).json().code,
    ).toBe('CODE_EXPIRED');
  });
  it('重发使旧验证码失效，刷新恢复需原密码，邮件失败有持久化真实失败状态', async () => {
    const account = await start();
    expect(
      (
        await post('/auth/member/registration/recover', {
          email: account.email,
          password: 'incorrect fictional password',
        })
      ).statusCode,
    ).toBe(400);
    const resent = await post('/auth/member/registration/resend', {
      challenge: account.challenge,
      password,
    });
    expect(resent.statusCode).toBe(200);
    const next = codeFor(account.email);
    expect(next).not.toBe(account.code);
    expect(
      (
        await post('/auth/member/registration/complete', {
          challenge: account.challenge,
          code: account.code,
          password,
        })
      ).statusCode,
    ).toBe(400);
    await finish({ ...account, code: next });
    client++;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('provider body must not escape', { status: 503 }),
      ),
    );
    const failed = await post('/auth/member/registration/start', {
      username: 'failure_' + client,
      email: 'failure_' + client + '@example.invalid',
      password,
      confirmPassword: password,
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe('MAIL_SEND_FAILED');
    expect(failed.body).not.toContain('provider body');
    const [event] = await sql.unsafe(
      'SELECT status,failure_code FROM member_mail_events ORDER BY created_at DESC LIMIT 1',
    );
    expect(event.status).toBe('FAILED');
    expect(event.failure_code).toBe('PROVIDER_REJECTED');
  });
  it('重复用户名明确提示；邮箱存在性仅在验证邮箱及原密码后披露', async () => {
    const original = await start();
    await finish(original);
    const duplicateName = await post('/auth/member/registration/start', {
      username: original.username,
      email: 'other_' + client + '@example.invalid',
      password,
      confirmPassword: password,
    });
    expect(duplicateName.statusCode).toBe(409);
    expect(duplicateName.json().code).toBe('USERNAME_UNAVAILABLE');
    const duplicateMail = await post('/auth/member/registration/start', {
      username: 'alt_' + randomUUID().replaceAll('-', '').slice(0, 10),
      email: original.email.toUpperCase(),
      password,
      confirmPassword: password,
    });
    expect(duplicateMail.statusCode).toBe(202);
    const check = await post('/auth/member/registration/complete', {
      challenge: duplicateMail.json().challenge,
      code: codeFor(original.email),
      password,
    });
    expect(check.statusCode).toBe(400);
    expect(check.json().code).toBe('EMAIL_IN_USE');
  });
  it('登录后修改密码撤销旧会话且通知，不允许改Owner密码', async () => {
    const account = await start(),
      session = await finish(account);
    expect(
      (
        await privateRequest(session, '/api/member/password', 'POST', {
          currentPassword: 'wrong-password',
          newPassword: changedPassword,
        })
      ).statusCode,
    ).toBe(403);
    const changed = await privateRequest(
      session,
      '/api/member/password',
      'POST',
      { currentPassword: password, newPassword: changedPassword },
    );
    expect(changed.statusCode).toBe(200);
    expect((await privateRequest(session, '/api/me')).statusCode).toBe(401);
    expect(
      (
        await post('/auth/member/login', {
          identifier: account.email,
          password,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await post('/auth/member/login', {
          identifier: account.email,
          password: changedPassword,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await privateRequest(ownerSession, '/api/member/password', 'POST', {
          currentPassword: password,
          newPassword: changedPassword,
        })
      ).statusCode,
    ).toBe(403);
    await settleAccountMail();
    expect(
      outbox.some(
        (m) => m.to[0] === account.email && m.subject.includes('密码修改'),
      ),
    ).toBe(true);
  });
  it('前三天授权接入激活、到期真正阻止API和旧订阅，管理员单独开放且记录审计', async () => {
    provider();
    client++;
    const now = Date.now(),
      policy = {
        enabled: true,
        windowStart: new Date(now - 3600000).toISOString(),
        windowEnd: new Date(now + 2 * 86400000).toISOString(),
        nodeSourceId: null,
        nodeLimit: 5,
        trialValidDays: 3,
      };
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/auto-grant-policy',
          'PATCH',
          policy,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await privateRequest(ownerSession, '/api/admin/auto-grant-policy')
      ).json(),
    ).toEqual(policy);
    const account = await start(),
      session = await finish(account);
    const profile = (
      await privateRequest(session, '/api/member/profile')
    ).json();
    expect(profile.capabilities).toEqual({
      node: true,
      server: true,
      codex: true,
    });
    const records = await sql.unsafe(
      'SELECT kind,expires_at FROM auto_grant_records WHERE user_id=$1',
      [session.id],
    );
    expect(records.map((x) => x.kind).sort()).toEqual([
      'codex',
      'node',
      'server',
    ]);
    const firstExpiry = records[0].expires_at;
    await privateRequest(
      ownerSession,
      '/api/admin/auto-grant/backfill',
      'POST',
      {},
    );
    const [same] = await sql.unsafe(
      'SELECT expires_at FROM auto_grant_records WHERE user_id=$1 LIMIT 1',
      [session.id],
    );
    expect(same.expires_at).toEqual(firstExpiry);
    const rotation = await privateRequest(
      session,
      '/api/subscription/rotate',
      'POST',
      {},
    );
    expect(rotation.statusCode).toBe(200);
    const link = rotation.json().url;
    expect(typeof link).toBe('string');
    await sql.unsafe(
      "UPDATE users SET node_access_until=now()-interval '1 second',server_connect_until=now()-interval '1 second',codex_tasks_until=now()-interval '1 second' WHERE id=$1",
      [session.id],
    );
    for (const path of [
      '/api/subscription/profile',
      '/api/server_connections',
      '/api/ai/tasks',
    ])
      expect((await privateRequest(session, path)).statusCode).toBe(403);
    expect((await app.inject(new URL(link, origin).pathname)).statusCode).toBe(
      403,
    );
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/users/' + session.id,
          'PATCH',
          { serverConnectEnabled: true },
        )
      ).statusCode,
    ).toBe(200);
    const current = (
      await privateRequest(session, '/api/member/profile')
    ).json();
    expect(current.capabilities).toEqual({
      node: false,
      server: true,
      codex: false,
    });
    const audit = await sql.unsafe(
      "SELECT target_id FROM audit_events WHERE action='member.capabilities_updated'",
    );
    expect(audit.some((x) => x.target_id.includes(session.id))).toBe(true);
    await privateRequest(
      ownerSession,
      '/api/admin/auto-grant-policy',
      'PATCH',
      { ...policy, enabled: false },
    );
  });
  it('活动结束新用户不自动授权，Owner不可通过策略改绑，管理邮件响应无凭据', async () => {
    client++;
    provider();
    const now = Date.now();
    await privateRequest(
      ownerSession,
      '/api/admin/auto-grant-policy',
      'PATCH',
      {
        enabled: true,
        windowStart: new Date(now - 3 * 86400000).toISOString(),
        windowEnd: new Date(now - 1000).toISOString(),
        nodeSourceId: null,
        nodeLimit: null,
        trialValidDays: 3,
      },
    );
    const account = await start(),
      session = await finish(account);
    expect(
      (await privateRequest(session, '/api/member/profile')).json()
        .capabilities,
    ).toEqual({ node: false, server: false, codex: false });
    expect(
      (
        await privateRequest(
          session,
          '/api/admin/auto-grant-policy',
          'PATCH',
          {},
        )
      ).statusCode,
    ).toBe(403);
    const list = await privateRequest(ownerSession, '/api/admin/member-mail');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(process.env.MAIL_API_KEY!);
    expect(list.body).not.toContain(account.code);
    expect(list.body).not.toContain(account.email);
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/users/' + owner.id,
          'PATCH',
          { nodeAccessEnabled: false },
        )
      ).statusCode,
    ).toBe(403);
    const [binding] = await sql.unsafe(
      'SELECT owner_id,google_sub,closed FROM owner_initialization WHERE singleton',
    );
    expect(binding.owner_id).toBe(owner.id);
    expect(binding.closed).toBe(true);
  });

  it('较早邮件请求失败不会作废后来已成功重发的验证码', async () => {
    client++;
    await privateRequest(
      ownerSession,
      '/api/admin/member-registration',
      'PATCH',
      {
        enabled: true,
        seatLimit: 1000,
      },
    );
    const username = 'race_' + randomUUID().replaceAll('-', '').slice(0, 10);
    const email = username + '@example.invalid';
    let first = true;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: any) => {
        const message = JSON.parse(options.body);
        outbox.push(message);
        if (message.to[0] === email && first) {
          first = false;
          entered();
          return new Promise<Response>((resolve) => {
            release = () => resolve(new Response('{}', { status: 503 }));
          });
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const original = post('/auth/member/registration/start', {
      username,
      email,
      password,
      confirmPassword: password,
    });
    await waiting;
    const recovered = await post('/auth/member/registration/recover', {
      email,
      password,
    });
    expect(recovered.statusCode).toBe(200);
    const currentCode = codeFor(email);
    release();
    expect((await original).statusCode).toBe(503);
    const session = await finish({
      challenge: recovered.json().challenge,
      code: currentCode,
    });
    expect((await privateRequest(session, '/api/me')).statusCode).toBe(200);
  });
});

describe('节点授权资源边界', () => {
  it('活动只分配允许的节点源；到期旧链接失效，手动重授权不会恢复其他权限', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: any) => {
        outbox.push(JSON.parse(options.body));
        return new Response('{}', { status: 200 });
      }),
    );
    const uri =
      'ss://' +
      Buffer.from('aes-256-gcm:synthetic-node-password').toString('base64') +
      '@node.example.invalid:443#synthetic';
    const created = await privateRequest(
      ownerSession,
      '/api/node_sources',
      'POST',
      {
        name: '授权源夹具',
        kind: 'OWNED_NODE',
        authorized: true,
        content: uri,
      },
    );
    expect(created.statusCode).toBe(200);
    const sourceId = created.json().id;
    const now = Date.now(),
      policy = {
        enabled: true,
        windowStart: new Date(now - 3600000).toISOString(),
        windowEnd: new Date(now + 2 * 86400000).toISOString(),
        nodeSourceId: sourceId,
        nodeLimit: 5,
        trialValidDays: 3,
      };
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/auto-grant-policy',
          'PATCH',
          policy,
        )
      ).statusCode,
    ).toBe(200);
    const account = await activate();
    const rotated = await privateRequest(
      account.session,
      '/api/subscription/rotate',
      'POST',
      {},
    );
    expect(rotated.statusCode).toBe(200);
    const link = new URL(rotated.json().url);
    expect((await app.inject(link.pathname + '?format=uri')).body).toContain(
      'ss://',
    );
    await sql.unsafe(
      "UPDATE users SET node_access_until=now()-interval '1 second' WHERE id=$1",
      [account.id],
    );
    expect((await app.inject(link.pathname + '?format=uri')).statusCode).toBe(
      403,
    );
    await sql.unsafe(
      'UPDATE node_group_grants SET data=data||\'{"expiresAt":"2000-01-01T00:00:00Z"}\' WHERE user_id=$1',
      [account.id],
    );
    expect(
      (
        await privateRequest(
          ownerSession,
          '/api/admin/users/' + account.id,
          'PATCH',
          { nodeAccessEnabled: true },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject(link.pathname + '?format=uri')).body,
    ).not.toContain('ss://');
    expect(
      (
        await privateRequest(ownerSession, '/api/admin/grants', 'POST', {
          kind: 'source',
          resourceId: sourceId,
          userId: account.id,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(link.pathname + '?format=uri')).body).toContain(
      'ss://',
    );
    await privateRequest(
      ownerSession,
      '/api/admin/grants/source/' + sourceId + '/' + account.id,
      'DELETE',
    );
    expect(
      (await app.inject(link.pathname + '?format=uri')).body,
    ).not.toContain('ss://');
  });
});

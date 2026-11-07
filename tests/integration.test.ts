import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { Server as SshServer } from 'ssh2';
import { OAuth2Client } from 'google-auth-library';
import { buildApp } from '../apps/api/src/server';
import { sql } from '../packages/db/src';
import { createSession, activateGoogle } from '../packages/auth/src';
import { token, seal, unseal, hash } from '../packages/shared/src/crypto';
import { runAiTask, runSubscriptionJob, tick } from '../apps/worker/src/jobs';
vi.mock('../packages/subscription/src/network', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    safeFetch: vi.fn(),
    resolvePublic: vi.fn(async (host: string) => {
      if (host === 'ssh-fixture.example')
        return { address: '127.0.0.1', family: 4 };
      if (host === 'blocked.invalid') throw Error('blocked');
      return { address: '8.8.8.8', family: 4 };
    }),
  };
});
import { safeFetch } from '../packages/subscription/src/network';
const providerMock = vi.hoisted(() => ({
  create: vi.fn(async function* () {
    yield { type: 'response.output_text.delta', delta: '真实适配器测试输出' };
  }),
}));
vi.mock('openai', () => ({
  default: class {
    responses = { create: providerMock.create };
  },
}));
const origin = 'http://localhost:5173';
let app: Awaited<ReturnType<typeof buildApp>>;
const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const sessions: any[] = [];
const sources: string[] = [];
const send = (
  i: number,
  url: string,
  method: any = 'GET',
  body?: any,
  headers: any = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      origin,
      cookie: `fafa_session=${sessions[i].raw}`,
      'x-csrf-token': sessions[i].csrf,
      ...headers,
    },
    ...(body ? { payload: body } : {}),
  });
beforeAll(async () => {
  app = await buildApp();
  for (const [i, role] of ['Owner', 'Member', 'Member', 'Viewer'].entries()) {
    const [u] =
      await sql`insert into users(id,email,name,role) values(${ids[i]},${token() + '@example.invalid'},${'测试' + i},${role}) returning *`;
    sessions.push(await createSession(u as any));
  }
});
afterAll(async () => {
  await sql`update users set deleted_at=now() where id in ${sql(ids)}`;
  await app.close();
  await sql.end();
});
describe('真实数据库 API 闭环', () => {
  it('匿名、CSRF 与 Viewer 写入拦截', async () => {
    expect((await app.inject('/api/me')).statusCode).toBe(401);
    expect(
      (
        await send(
          1,
          '/api/location_presets',
          'POST',
          { name: 'test', latitude: 1, longitude: 2 },
          { 'x-csrf-token': 'bad' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(3, '/api/location_presets', 'POST', {
          name: 'test',
          latitude: 1,
          longitude: 2,
        })
      ).statusCode,
    ).toBe(403);
    expect((await send(1, '/api/admin/users')).statusCode).toBe(403);
  });
  it('管理端精确 CORS 预检与 CSRF 来源校验', async () => {
    const adminOrigin = 'http://localhost:5174';
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/admin/users',
      headers: {
        origin: adminOrigin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-csrf-token,content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(adminOrigin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(
      (
        await send(0, '/api/admin/users', 'GET', undefined, {
          origin: adminOrigin,
        })
      ).statusCode,
    ).toBe(200);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const allowed = await app.inject({
        method: 'OPTIONS',
        url: '/api/node_sources',
        headers: {
          origin: adminOrigin,
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type,x-csrf-token',
        },
      });
      expect(allowed.statusCode).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(adminOrigin);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      expect(
        String(allowed.headers['access-control-allow-methods'])
          .split(',')
          .map((value) => value.trim()),
      ).toContain(method);
      const blocked = await app.inject({
        method: 'OPTIONS',
        url: '/api/node_sources',
        headers: {
          origin: 'https://evil.invalid',
          'access-control-request-method': method,
        },
      });
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    }
    const evil = await send(
      1,
      '/api/location_presets',
      'POST',
      { name: '拒绝写入', latitude: 1, longitude: 2 },
      { origin: 'https://evil.invalid' },
    );
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(evil.json().code).toBe('CSRF');
  });
  it('生产 OAuth 回调与 host-only Secure 会话（Google SDK stub）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_DOMAIN', '');
    vi.stubEnv('WEB_ORIGIN', 'https://fafa888.uk');
    vi.stubEnv('ADMIN_ORIGIN', 'https://a.fafa888.uk');
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'https://fafa888.uk/auth/google/callback',
    );
    vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-not-a-real-secret');
    const production = await buildApp();
    const sub = token();
    await sql`insert into google_identities(user_id,sub) values(${ids[0]},${sub})`;
    try {
      const begin = await production.inject('/auth/google');
      expect(begin.statusCode).toBe(302);
      const cookie = begin.cookies.find((c) => c.name === 'fafa_oidc')!;
      expect(cookie.domain).toBeUndefined();
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      const flow = JSON.parse(
        unseal(JSON.parse(Buffer.from(cookie.value, 'base64url').toString())),
      );
      const exchange = vi
        .spyOn(OAuth2Client.prototype, 'getToken')
        .mockResolvedValue({ tokens: { id_token: 'fixture' } } as any);
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
        getPayload: () => ({
          sub,
          email: 'fixture@example.invalid',
          email_verified: true,
          nonce: flow.nonce,
          iss: 'https://accounts.google.com',
          aud: 'fixture.apps.googleusercontent.com',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      } as any);
      const callback = await production.inject({
        url: '/auth/google/callback?state=' + flow.state + '&code=fixture',
        headers: { cookie: 'fafa_oidc=' + cookie.value },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('https://fafa888.uk');
      expect(exchange).toHaveBeenCalledWith({
        code: 'fixture',
        codeVerifier: flow.verifier,
      });
      const session = callback.cookies.find((c) => c.name === 'fafa_session')!;
      expect(session.domain).toBeUndefined();
      expect(session.secure).toBe(true);
      expect(session.httpOnly).toBe(true);
      expect(session.sameSite).toBe('Lax');
      const admin = await production.inject({
        url: '/api/admin/users',
        headers: {
          origin: 'https://a.fafa888.uk',
          cookie: 'fafa_session=' + session.value,
        },
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.headers['access-control-allow-origin']).toBe(
        'https://a.fafa888.uk',
      );
      expect((await production.inject('/auth/config')).json().mock).toBe(false);
    } finally {
      await production.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
  it('Google 登录按来源回跳：后台回管理域名，前台回主域名，无效来源拒绝', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_DOMAIN', '');
    vi.stubEnv('WEB_ORIGIN', 'https://fafa888.uk');
    vi.stubEnv('ADMIN_ORIGIN', 'https://a.fafa888.uk');
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'https://fafa888.uk/auth/google/callback',
    );
    vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-not-a-real-secret');
    const production = await buildApp();
    const sub = token();
    await sql`insert into google_identities(user_id,sub) values(${ids[0]},${sub})`;
    let currentNonce = '';
    try {
      // 无效来源直接拒绝，不产生登录状态
      for (const bad of ['https://evil.invalid', 'admin2', 'ADMIN']) {
        const rejected = await production.inject(
          '/auth/google?app=' + encodeURIComponent(bad),
        );
        expect(rejected.statusCode).toBe(400);
      }
      vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
        tokens: { id_token: 'fixture' },
      } as any);
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
        getPayload: () => ({
          sub,
          email: 'fixture@example.invalid',
          email_verified: true,
          nonce: currentNonce,
          iss: 'https://accounts.google.com',
          aud: 'fixture.apps.googleusercontent.com',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      } as any);
      const beginAndCallback = async (app: string | undefined) => {
        const query = app === undefined ? '' : '?app=' + app;
        const begin = await production.inject('/auth/google' + query);
        expect(begin.statusCode).toBe(302);
        const cookie = begin.cookies.find((c) => c.name === 'fafa_oidc')!;
        const flow = JSON.parse(
          unseal(JSON.parse(Buffer.from(cookie.value, 'base64url').toString())),
        );
        currentNonce = flow.nonce;
        const callback = await production.inject({
          url: '/auth/google/callback?state=' + flow.state + '&code=fixture',
          headers: { cookie: 'fafa_oidc=' + cookie.value },
        });
        return { flow, callback };
      };
      // 管理入口回管理域名
      const adminLogin = await beginAndCallback('admin');
      expect(adminLogin.flow.app).toBe('admin');
      expect(adminLogin.callback.statusCode).toBe(302);
      expect(adminLogin.callback.headers.location).toBe('https://a.fafa888.uk');
      // 管理入口登录的 Owner 会话仍可访问管理员接口
      const ownerSession = adminLogin.callback.cookies.find(
        (c) => c.name === 'fafa_session',
      )!;
      const adminUsers = await production.inject({
        url: '/api/admin/users',
        headers: {
          origin: 'https://a.fafa888.uk',
          cookie: 'fafa_session=' + ownerSession.value,
        },
      });
      expect(adminUsers.statusCode).toBe(200);
      // 前台入口回主域名
      const webLogin = await beginAndCallback('web');
      expect(webLogin.flow.app).toBe('web');
      expect(webLogin.callback.statusCode).toBe(302);
      expect(webLogin.callback.headers.location).toBe('https://fafa888.uk');
      // 未传来源默认回主域名（兼容旧链接）
      const defaultLogin = await beginAndCallback(undefined);
      expect(defaultLogin.flow.app).toBe('web');
      expect(defaultLogin.callback.headers.location).toBe('https://fafa888.uk');
    } finally {
      await production.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
  it('普通成员从管理入口登录仍被拒绝管理员功能', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_DOMAIN', '');
    vi.stubEnv('WEB_ORIGIN', 'https://fafa888.uk');
    vi.stubEnv('ADMIN_ORIGIN', 'https://a.fafa888.uk');
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'https://fafa888.uk/auth/google/callback',
    );
    vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-not-a-real-secret');
    const production = await buildApp();
    const memberSub = token();
    await sql`insert into google_identities(user_id,sub) values(${ids[1]},${memberSub})`;
    let currentNonce = '';
    try {
      vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
        tokens: { id_token: 'fixture' },
      } as any);
      vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
        getPayload: () => ({
          sub: memberSub,
          email: 'member-fixture@example.invalid',
          email_verified: true,
          nonce: currentNonce,
          iss: 'https://accounts.google.com',
          aud: 'fixture.apps.googleusercontent.com',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      } as any);
      const begin = await production.inject('/auth/google?app=admin');
      expect(begin.statusCode).toBe(302);
      const cookie = begin.cookies.find((c) => c.name === 'fafa_oidc')!;
      const flow = JSON.parse(
        unseal(JSON.parse(Buffer.from(cookie.value, 'base64url').toString())),
      );
      expect(flow.app).toBe('admin');
      currentNonce = flow.nonce;
      const callback = await production.inject({
        url: '/auth/google/callback?state=' + flow.state + '&code=fixture',
        headers: { cookie: 'fafa_oidc=' + cookie.value },
      });
      // 回跳管理域名，但会话仍是普通成员
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe('https://a.fafa888.uk');
      const memberSession = callback.cookies.find(
        (c) => c.name === 'fafa_session',
      )!;
      const denied = await production.inject({
        url: '/api/admin/users',
        headers: {
          origin: 'https://a.fafa888.uk',
          cookie: 'fafa_session=' + memberSession.value,
        },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await production.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
  it('批量 SS/VMess 导入、权限、筛选、节点编辑与撤销', async () => {
    const raw =
      'ss://' +
      Buffer.from('aes-256-gcm:fictional-fixture-password').toString(
        'base64url',
      ) +
      '@node.example.com:8388#' +
      encodeURIComponent('香港 IEPL 0.5倍 下载专用');
    const input = {
      name: '隔离导入 fixture',
      group: '下载组',
      kind: 'THIRD_PARTY_NODE',
      content: raw + '\n' + raw + '\ninvalid-fixture',
      authorized: true,
      redistributionAuthorized: true,
      authorizationReference: '虚构提供商授权 fixture',
    };
    expect((await send(1, '/api/node-import', 'POST', input)).statusCode).toBe(
      403,
    );
    const preview = await send(0, '/api/node-import/preview', 'POST', input);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      total: 3,
      valid: 1,
      countries: { 香港: 1 },
      protocols: { ss: 1 },
      duplicates: 1,
      failures: [{ line: 3, code: 'PARSE_FAILED' }],
    });
    expect(preview.body).not.toContain('fictional-fixture-password');
    const imported = await send(0, '/api/node-import', 'POST', input);
    expect(imported.statusCode).toBe(200);
    const id = imported.json().sourceId;
    const [stored] = await sql`select * from nodes where source_id=${id}`;
    expect(JSON.stringify(stored)).not.toContain('fictional-fixture-password');
    const node = (await send(0, '/api/nodes'))
      .json()
      .find((n: any) => n.sourceId === id);
    expect(node.country).toBe('香港');
    expect(node.status).toBe('PENDING_VERIFICATION');
    expect(
      (await send(1, '/api/nodes/' + node.id, 'PATCH', { enabled: false }))
        .statusCode,
    ).toBe(404);
    await send(0, '/api/admin/grants', 'POST', {
      kind: 'source',
      resourceId: id,
      userId: ids[1],
    });
    const url = (await send(1, '/api/subscription/rotate', 'POST')).json().url;
    const path = new URL(url).pathname;
    expect((await app.inject(path + '?format=uri')).body).toContain('ss://');
    await send(1, '/api/subscription/profile', 'PUT', {
      country: '美国',
      protocol: 'ss',
      group: '下载组',
    });
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(1, '/api/subscription/profile', 'PUT', {
      country: '香港',
      protocol: 'vmess',
    });
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(1, '/api/subscription/profile', 'PUT', {
      country: '香港',
      protocol: 'ss',
      group: '下载组',
    });
    expect((await app.inject(path + '?format=uri')).body).toContain('ss://');
    await send(0, '/api/nodes/' + node.id, 'PATCH', { enabled: false });
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(0, '/api/nodes/' + node.id, 'PATCH', { enabled: true });
    expect((await app.inject(path + '?format=uri')).body).toContain('ss://');
    await send(0, '/api/nodes/' + node.id, 'DELETE');
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(1, '/api/subscription/profile', 'PUT', { country: '' });
    await send(0, '/api/node_sources/' + id, 'DELETE');
  });
  it('源停用时启用节点返回 409 SOURCE_DISABLED', async () => {
    const raw =
      'ss://' +
      Buffer.from('aes-256-gcm:fictional-fixture-password').toString(
        'base64url',
      ) +
      '@node.example.com:8388#' +
      encodeURIComponent('409 回归 fixture');
    const imported = await send(0, '/api/node-import', 'POST', {
      name: '409 回归 fixture',
      group: '',
      kind: 'THIRD_PARTY_NODE',
      content: raw,
      authorized: true,
      redistributionAuthorized: true,
      authorizationReference: '虚构提供商授权 fixture',
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const id = imported.json().sourceId;
    const node = (await send(0, '/api/nodes'))
      .json()
      .find((n: any) => n.sourceId === id);
    expect(
      (
        await send(0, '/api/node_sources/' + id + '/enabled', 'PATCH', {
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    const blocked = await send(0, '/api/nodes/' + node.id, 'PATCH', {
      enabled: true,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('SOURCE_DISABLED');
    expect(
      (await send(0, '/api/nodes/' + node.id, 'PATCH', { enabled: false }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await send(0, '/api/node_sources/' + id + '/enabled', 'PATCH', {
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await send(0, '/api/nodes/' + node.id, 'PATCH', { enabled: true }))
        .statusCode,
    ).toBe(200);
    await send(0, '/api/nodes/' + node.id, 'DELETE');
    await send(0, '/api/node_sources/' + id, 'DELETE');
  });
  it('自有订阅创建、持久化、密钥不同节点保留', async () => {
    const r = await send(1, '/api/node_sources', 'POST', {
      name: '真实配置测试',
      kind: 'OWNED_NODE',
      content:
        'trojan://one@node.example.com:443#A\ntrojan://two@node.example.com:443#B',
      country: '日本',
      authorized: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    sources.push(r.json().id);
    const list = (await send(1, '/api/node_sources')).json();
    expect(list[0].nodeCount).toBe(2);
    expect(JSON.stringify(list)).not.toContain('trojan://');
  });
  it('跨用户对象返回 404 并追加安全审计', async () => {
    const r = await send(2, '/api/node_sources/' + sources[0]);
    expect(r.statusCode).toBe(404);
    expect(
      (
        await sql`select id from audit_events where owner_id=${ids[2]} and action='access.denied'`
      ).length,
    ).toBeGreaterThan(0);
  });
  it('订阅 Token 轮换、导出、撤销、出口过滤', async () => {
    const first = (await send(1, '/api/subscription/rotate', 'POST')).json()
      .url;
    const path = new URL(first).pathname;
    expect(path).toMatch(/^\/api\/subscription\/download\//);
    expect(path).not.toContain('/api/api/');
    const legacy = '/subscription/' + path.split('/').pop();
    expect((await app.inject(legacy)).statusCode).toBe(200);
    expect((await app.inject('/api/subscription/profile')).statusCode).toBe(
      401,
    );
    const output = await app.inject(path + '?format=mihomo');
    expect(output.statusCode).toBe(200);
    expect(output.body).toContain('proxies:');
    expect(output.headers['cache-control']).toBe('no-store');
    await send(1, '/api/subscription/profile', 'PUT', { country: '美国' });
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(1, '/api/subscription/profile', 'PUT', { country: '' });
    await send(1, '/api/subscription/rotate', 'POST');
    expect((await app.inject(path)).statusCode).toBe(404);
    expect((await app.inject(legacy)).statusCode).toBe(404);
    await send(1, '/api/subscription', 'DELETE');
  });
  it('共享资源只能由拥有者授权，撤销立即生效', async () => {
    const denied = await send(0, '/api/admin/grants', 'POST', {
      kind: 'source',
      resourceId: sources[0],
      userId: ids[2],
    });
    expect(denied.statusCode).toBe(404);
    await sql`update users set role='Admin' where id=${ids[1]}`;
    expect(
      (
        await send(1, '/api/admin/grants', 'POST', {
          kind: 'source',
          resourceId: sources[0],
          userId: ids[2],
        })
      ).statusCode,
    ).toBe(200);
    expect((await send(2, '/api/summary')).json().nodes).toBe(2);
    await send(1, `/api/admin/grants/source/${sources[0]}/${ids[2]}`, 'DELETE');
    expect((await send(2, '/api/summary')).json().nodes).toBe(0);
    await sql`update users set role='Member' where id=${ids[1]}`;
  });
  it('SS 与 VMess 混合批量导入通过独立订阅兼容格式输出，公开摘要不泄露凭据', async () => {
    const vmessId = randomUUID();
    const ss =
      'ss://' +
      Buffer.from('aes-256-gcm:fixture-batch-secret').toString('base64url') +
      '@ss.example.com:8388#' +
      encodeURIComponent('香港 IEPL 0.5倍');
    const vmess =
      'vmess://' +
      Buffer.from(
        JSON.stringify({
          v: '2',
          ps: '日本 下载专用 2x',
          add: 'vmess.example.com',
          port: '443',
          id: vmessId,
          aid: '0',
          scy: 'auto',
          net: 'ws',
          type: 'none',
          host: 'edge.example.com',
          path: '/ws',
          tls: 'tls',
          sni: 'tls.example.com',
        }),
      ).toString('base64');
    const input = {
      name: '双协议批量',
      kind: 'THIRD_PARTY_NODE',
      group: '第三方授权',
      content: Buffer.from(ss + '\n' + vmess + '\n' + ss).toString('base64'),
      authorized: true,
      redistributionAuthorized: true,
      authorizationReference: 'fixture-authorized-provider',
    };
    const preview = await send(0, '/api/node-import/preview', 'POST', input);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      valid: 2,
      duplicates: 1,
      failures: [],
    });
    expect(preview.body).not.toContain(vmessId);
    const imported = await send(0, '/api/node-import', 'POST', input);
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json()).toMatchObject({ imported: 2, duplicates: 1 });
    const id = imported.json().sourceId;
    const metadata = await send(0, '/api/nodes');
    expect(metadata.body).not.toContain('fixture-batch-secret');
    expect(metadata.body).not.toContain(vmessId);
    const grant = await send(0, '/api/admin/grants', 'POST', {
      kind: 'source',
      resourceId: id,
      userId: ids[2],
    });
    expect(grant.statusCode).toBe(200);
    const link = new URL(
      (await send(2, '/api/subscription/rotate', 'POST')).json().url,
    ).pathname;
    const output = await app.inject(link + '?format=uri');
    expect(output.statusCode).toBe(200);
    expect(output.body).toContain('ss://');
    expect(output.body).toContain('vmess://');
    const encoded = await app.inject(link + '?format=base64');
    expect(Buffer.from(encoded.body, 'base64').toString()).toBe(output.body);
    expect((await app.inject(link + '?format=mihomo')).body).toContain(
      'proxies:',
    );
    expect(
      (await app.inject(link + '?format=sing-box')).json().outbounds,
    ).toHaveLength(2);
    await send(0, '/api/admin/grants/source/' + id + '/' + ids[2], 'DELETE');
    expect((await app.inject(link + '?format=uri')).body).toBe('');
    expect(
      (
        await app.inject(
          '/subscription/' + link.split('/').pop() + '?format=uri',
        )
      ).body,
    ).toBe('');
    await send(2, '/api/subscription', 'DELETE');
    await send(0, '/api/node_sources/' + id, 'DELETE');
  });
  it('源元数据编辑不回显凭据，远程刷新防重、失败回滚并拒绝陈旧结果', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    const privateUrl =
      'https://provider.example/subscription?token=fixture-private-url';
    const content =
      'ss://' +
      Buffer.from('aes-256-gcm:fixture-remote-secret').toString('base64url') +
      '@node.example.com:8388#' +
      encodeURIComponent('日本 IEPL 2倍');
    try {
      const created = await send(0, '/api/node_sources', 'POST', {
        name: '远程授权测试',
        kind: 'REMOTE_SUBSCRIPTION',
        url: privateUrl,
        group: '提供商分组',
        authorized: true,
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().credentialConfigured).toBe(true);
      expect(created.body).not.toContain(privateUrl);
      const id = created.json().id;
      const [queued] =
        await sql`select * from background_jobs where source_id=${id} and data->>'status'='QUEUED'`;
      expect(queued).toBeTruthy();
      const refreshes = await Promise.all([
        send(0, '/api/node_sources/' + id + '/refresh', 'POST'),
        send(0, '/api/node_sources/' + id + '/refresh', 'POST'),
      ]);
      expect(
        refreshes.every(
          (r) => r.statusCode === 200 && r.json().id === queued.id,
        ),
      ).toBe(true);
      vi.mocked(safeFetch).mockResolvedValueOnce({
        status: 200,
        body: content,
      });
      await runSubscriptionJob(queued);
      const [before] = await sql`select * from node_sources where id=${id}`;
      const [firstNode] =
        await sql`select * from nodes where source_id=${id} and revoked_at is null`;
      const updated = await send(0, '/api/node_sources/' + id, 'PATCH', {
        name: '已改名',
        group: '新版分组',
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.body).not.toContain('fixture-private-url');
      expect(
        (await send(1, '/api/node_sources/' + id, 'PATCH', { name: '越权' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await send(0, '/api/node_sources/' + id, 'PATCH', { url: privateUrl }))
          .statusCode,
      ).toBe(400);
      const [after] = await sql`select * from node_sources where id=${id}`;
      expect(after.secret).toEqual(before.secret);
      expect(after.data.nodeCount).toBe(1);
      vi.mocked(safeFetch).mockResolvedValueOnce({
        status: 200,
        body: 'invalid-provider-response',
      });
      await expect(runSubscriptionJob(queued)).rejects.toThrow();
      const retained =
        await sql`select * from nodes where source_id=${id} and revoked_at is null`;
      expect(retained.map((node) => node.id)).toEqual([firstNode.id]);
      vi.mocked(safeFetch).mockRejectedValueOnce(new Error(privateUrl));
      await tick();
      const [failed] = await sql`select data from node_sources where id=${id}`;
      expect(failed.data.status).toBe('ERROR');
      expect(failed.data.lastSuccess).toBe(after.data.lastSuccess);
      expect(failed.data.error).toBe('刷新失败，保留最后成功版本');
      const [failedJob] =
        await sql`select data from background_jobs where id=${queued.id}`;
      expect(failedJob.data.attempt).toBe(1);
      expect(JSON.stringify(failedJob.data)).not.toContain(
        'fixture-private-url',
      );
      const invalid = await send(0, '/api/node_sources/' + id, 'PUT', {
        name: '无效替换',
        kind: 'OWNED_NODE',
        content: 'invalid-node',
        authorized: true,
      });
      expect(invalid.statusCode).toBe(400);
      expect((await send(0, '/api/node_sources/' + id)).json().name).toBe(
        '已改名',
      );
      vi.mocked(safeFetch).mockImplementationOnce(async () => {
        const replacement = await send(0, '/api/node_sources/' + id, 'PUT', {
          name: '新连接',
          kind: 'REMOTE_SUBSCRIPTION',
          url: 'https://new-provider.example/sub?token=fixture-new',
          authorized: true,
        });
        expect(replacement.statusCode, replacement.body).toBe(200);
        return {
          status: 200,
          body: 'trojan://outdated@old-node.example.com:443#old',
        };
      });
      expect(await runSubscriptionJob(queued)).toEqual({ superseded: true });
      expect(
        (
          await sql`select id from nodes where source_id=${id} and revoked_at is null`
        ).map((node) => node.id),
      ).toEqual([firstNode.id]);
      expect(
        (
          await sql`select id from background_jobs where source_id=${id} and data->>'status' in ('QUEUED','RUNNING')`
        ).length,
      ).toBe(1);
      expect(
        (
          await send(0, '/api/node_sources/' + id + '/enabled', 'PATCH', {
            enabled: false,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await send(0, '/api/node_sources/' + id + '/refresh', 'POST'))
          .statusCode,
      ).toBe(400);
      expect(
        (await send(0, '/api/nodes'))
          .json()
          .find((node: any) => node.sourceId === id),
      ).toMatchObject({
        enabled: false,
        status: 'DISABLED',
        editable: true,
        latency: null,
        traffic: null,
      });
      await send(0, '/api/node_sources/' + id + '/enabled', 'PATCH', {
        enabled: true,
      });
      vi.mocked(safeFetch).mockImplementationOnce(async () => {
        await send(0, '/api/node_sources/' + id + '/enabled', 'PATCH', {
          enabled: false,
        });
        return { status: 200, body: content };
      });
      expect(await runSubscriptionJob({ source_id: id })).toEqual({
        superseded: true,
      });
      await send(0, '/api/node_sources/' + id, 'DELETE');
      expect(
        (
          await sql`select id from background_jobs where source_id=${id} and data->>'status' in ('QUEUED','RUNNING')`
        ).length,
      ).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('分配列表、目标账户校验、重复及撤销后重新授权与第三方授权撤回', async () => {
    const created = await send(0, '/api/node_sources', 'POST', {
      name: '共享策略测试',
      kind: 'REMOTE_SUBSCRIPTION',
      url: 'https://provider.example/private',
      authorized: true,
      enabled: false,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    const grant = { kind: 'source', resourceId: id, userId: ids[2] };
    expect((await send(0, '/api/admin/grants', 'POST', grant)).statusCode).toBe(
      403,
    );
    expect(
      (
        await send(0, '/api/node_sources/' + id, 'PATCH', {
          redistributionAuthorized: true,
          authorizationReference: 'fixture-redistribution-contract',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send(0, '/api/admin/grants', 'POST', {
          ...grant,
          userId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect((await send(0, '/api/admin/grants', 'POST', grant)).statusCode).toBe(
      200,
    );
    expect((await send(0, '/api/admin/grants', 'POST', grant)).statusCode).toBe(
      200,
    );
    let grants = (await send(0, '/api/admin/grants'))
      .json()
      .filter((g: any) => g.resourceId === id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      kind: 'source',
      resourceId: id,
      userId: ids[2],
    });
    expect(
      (await send(2, '/api/shared-sources'))
        .json()
        .some((source: any) => source.id === id),
    ).toBe(true);
    expect(
      (
        await send(0, '/api/node_sources/' + id, 'PATCH', {
          redistributionAuthorized: false,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await send(2, '/api/shared-sources'))
        .json()
        .some((source: any) => source.id === id),
    ).toBe(false);
    expect(
      (await send(2, '/api/node_sources/' + id, 'DELETE')).statusCode,
    ).toBe(404);
    await send(0, '/api/admin/grants/source/' + id + '/' + ids[2], 'DELETE');
    expect(
      (await send(0, '/api/admin/grants'))
        .json()
        .some((g: any) => g.resourceId === id),
    ).toBe(false);
    await send(0, '/api/node_sources/' + id, 'PATCH', {
      redistributionAuthorized: true,
    });
    expect((await send(0, '/api/admin/grants', 'POST', grant)).statusCode).toBe(
      200,
    );
    grants = (await send(0, '/api/admin/grants'))
      .json()
      .filter((g: any) => g.resourceId === id);
    expect(grants).toHaveLength(1);
    await send(0, '/api/node_sources/' + id, 'DELETE');
  });
  it('流量额度仅持久化策略，明确没有真实计量或数据面限流', async () => {
    const update = await send(0, '/api/admin/users/' + ids[1], 'PATCH', {
      trafficLimitBytes: 10737418240,
    });
    expect(update.statusCode, update.body).toBe(200);
    const user = (await send(0, '/api/admin/users'))
      .json()
      .find((user: any) => user.id === ids[1]);
    expect(user).toMatchObject({
      trafficLimitBytes: 10737418240,
      trafficUsageBytes: null,
      trafficMeteringStatus: 'UNAVAILABLE',
      trafficQuotaEnforcement: 'NOT_ACTIVE',
    });
    expect(
      (
        await send(1, '/api/admin/users/' + ids[2], 'PATCH', {
          trafficLimitBytes: 0,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(0, '/api/admin/users/' + ids[1], 'PATCH', {
          trafficLimitBytes: -1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(0, '/api/admin/users/' + ids[1], 'PATCH', {
          trafficLimitBytes: null,
        })
      ).statusCode,
    ).toBe(200);
    const [stored] =
      await sql`select traffic_limit_bytes from users where id=${ids[1]}`;
    expect(stored.traffic_limit_bytes).toBeNull();
  });
  it('邀请、未验证邮箱、席位超额与 Google sub 绑定', async () => {
    const email = token() + '@example.invalid';
    expect(
      (
        await send(0, '/api/admin/invitations', 'POST', {
          email,
          role: 'Member',
        })
      ).statusCode,
    ).toBe(200);
    await expect(
      activateGoogle({ sub: token(), email, email_verified: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    await expect(
      activateGoogle({
        sub: token(),
        email: 'no-invite@example.invalid',
        email_verified: true,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
    const [previous] =
      await sql`select value from settings where key='seat_limit'`;
    await sql`update settings set value='1' where key='seat_limit'`;
    try {
      await expect(
        activateGoogle({ sub: token(), email, email_verified: true }),
      ).rejects.toMatchObject({ code: 'SEAT_LIMIT' });
    } finally {
      await sql`update settings set value=${sql.json(1000)} where key='seat_limit'`;
    }
    const sub = token();
    const user = await activateGoogle({ sub, email, email_verified: true });
    ids.push(user.id as any);
    const again = await activateGoogle({
      sub,
      email: 'changed@example.invalid',
      email_verified: true,
    });
    expect(again.id).toBe(user.id);
    await sql`update settings set value=${sql.json(previous.value)} where key='seat_limit'`;
  });
  it('AI 账户加密、切换隔离、演示任务不得调用外部', async () => {
    const key = 'sk-test-fixture-not-real';
    const a = (
      await send(1, '/api/ai_accounts', 'POST', { name: '开发', apiKey: key })
    ).json();
    expect(a.credentialConfigured).toBe(true);
    expect(JSON.stringify(a)).not.toContain(key);
    expect(
      (await send(2, '/api/ai/select', 'POST', { accountId: a.id })).statusCode,
    ).toBe(404);
    expect(
      (await send(1, '/api/ai/select', 'POST', { accountId: a.id })).statusCode,
    ).toBe(200);
    expect(
      (
        await send(1, '/api/ai/tasks', 'POST', {
          accountId: a.id,
          prompt: 'hello',
        })
      ).statusCode,
    ).toBe(409);
    const [stored] = await sql`select secret from ai_accounts where id=${a.id}`;
    expect(JSON.stringify(stored)).not.toContain(key);
  });
  it('SSH 未授权与演示出站必须拒绝', async () => {
    const r = await send(1, '/api/server_connections', 'POST', {
      name: '测试',
      host: 'server.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      credential: 'fixture-password',
      authorized: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    const id = r.json().id;
    expect((await send(2, `/api/servers/${id}/probe`, 'POST')).statusCode).toBe(
      404,
    );
    expect(
      (
        await send(1, `/api/servers/${id}/terminal-ticket`, 'POST', {
          confirmed: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await send(3, `/api/servers/${id}/terminal-ticket`, 'POST', {
          confirmed: true,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('位置保存、跨用户不可读，导出不包含秘密', async () => {
    const r = await send(1, '/api/location_presets', 'POST', {
      name: '上海',
      latitude: 31.2304,
      longitude: 121.4737,
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await send(2, '/api/location_presets/' + r.json().id)).statusCode,
    ).toBe(404);
    const exported = (await send(1, '/api/data-export')).json();
    expect(JSON.stringify(exported)).not.toContain('fixture-password');
    expect(exported.location_presets[0].name).toBe('上海');
  });
  it('刷新条件请求、diff 与失败保留最后成功版本', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    const [s] =
      await sql`insert into node_sources(owner_id,data,secret) values(${ids[1]},${sql.json({ name: '远程测试', kind: 'REMOTE_SUBSCRIPTION', enabled: true, country: '日本' })},${sql.json(seal('https://example.com/sub'))}) returning *`;
    const job = { source_id: s.id };
    vi.mocked(safeFetch).mockResolvedValueOnce({
      status: 200,
      body: 'trojan://password@node.example.com:443#A',
      etag: 'abc',
    });
    const result = await runSubscriptionJob(job);
    expect(result).toMatchObject({ added: 1, removed: 0 });
    vi.mocked(safeFetch).mockResolvedValueOnce({ status: 304, body: '' });
    expect(await runSubscriptionJob(job)).toEqual({ unchanged: true });
    expect(vi.mocked(safeFetch).mock.calls.at(-1)?.[1]).toMatchObject({
      'If-None-Match': 'abc',
    });
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('failed'));
    await expect(runSubscriptionJob(job)).rejects.toThrow();
    expect(
      (
        await sql`select * from nodes where source_id=${s.id} and revoked_at is null`
      ).length,
    ).toBe(1);
    vi.unstubAllEnvs();
  });
  it('OpenAI 任务适配器使用选定账户并持久化流式输出', async () => {
    vi.stubEnv('DEMO_MODE', 'false');
    const [account] =
      await sql`select * from ai_accounts where owner_id=${ids[1]} and revoked_at is null limit 1`;
    const [task] =
      await sql`insert into ai_tasks(owner_id,account_id,data) values(${ids[1]},${account.id},${sql.json({ status: 'RUNNING', prompt: 'hello', output: '' })}) returning *`;
    await runAiTask(task);
    const [stored] = await sql`select data from ai_tasks where id=${task.id}`;
    expect(stored.data.status).toBe('COMPLETED');
    expect(stored.data.output).toBe('真实适配器测试输出');
    const blockedStream = await send(
      1,
      `/api/ai/tasks/${task.id}/events`,
      'GET',
      undefined,
      { origin: 'https://evil.invalid' },
    );
    expect(blockedStream.statusCode).toBe(403);
    expect(
      blockedStream.headers['access-control-allow-origin'],
    ).toBeUndefined();
    const stream = await send(1, `/api/ai/tasks/${task.id}/events`);
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['access-control-allow-origin']).toBe(origin);
    expect(stream.body).toContain('真实适配器测试输出');

    expect(providerMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        store: false,
        stream: true,
        max_output_tokens: 2000,
      }),
      expect.anything(),
    );
    vi.unstubAllEnvs();
  });
  it('真实本地 SSH 握手、固定指纹与授权只读通道', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const fixture = new SshServer({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (
          ctx.method === 'password' &&
          ctx.username === 'fixture' &&
          ctx.password === 'fixture-pass'
        )
          ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (accept, _reject, info) => {
            const stream = accept();
            stream.write('fixture: ' + info.command);
            stream.exit(0);
            stream.end();
          });
        }),
      );
    });
    await new Promise<void>((resolve) =>
      fixture.listen(0, '127.0.0.1', resolve),
    );
    const address = fixture.address() as { port: number };
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('SSH_ALLOWED_TARGETS', `ssh-fixture.example:${address.port}`);
    try {
      const created = await send(1, '/api/server_connections', 'POST', {
        name: 'SSH fixture',
        host: 'ssh-fixture.example',
        port: address.port,
        username: 'fixture',
        authType: 'password',
        credential: 'fixture-pass',
        authorized: true,
      });
      const id = created.json().id;
      const probe = await send(1, `/api/servers/${id}/probe`, 'POST');
      expect(probe.statusCode, probe.body).toBe(200);
      const fingerprint = probe.json().fingerprint;
      expect(
        (
          await send(1, `/api/servers/${id}/pin`, 'POST', {
            fingerprint: 'wrong-fingerprint',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await send(1, `/api/servers/${id}/pin`, 'POST', { fingerprint }))
          .statusCode,
      ).toBe(200);
      const readonlyTicket = (
        await send(1, `/api/servers/${id}/terminal-ticket`, 'POST', {
          confirmed: true,
        })
      ).json().ticket;
      const deniedTicket = async (ticket: string) => {
        const denied = await app.injectWS(`/api/servers/${id}/terminal`, {
          headers: { origin, cookie: `fafa_session=${sessions[1].raw}` },
          socket: { remoteAddress: '127.0.0.1' } as any,
        });
        const closed = new Promise<number>((resolve) =>
          denied.once('close', (code: number) => resolve(code)),
        );
        denied.send(JSON.stringify({ ticket, csrf: sessions[1].csrf }));
        expect(await closed).toBe(1008);
      };
      await sql`update server_connections set data=data || '{"terminalMode":"interactive"}'::jsonb where id=${id}`;
      await deniedTicket(readonlyTicket);
      vi.stubEnv('SSH_INTERACTIVE_ENABLED', 'true');
      const interactiveTicket = (
        await send(1, `/api/servers/${id}/terminal-ticket`, 'POST', {
          confirmed: true,
          writeApproved: true,
        })
      ).json().ticket;
      expect(typeof interactiveTicket).toBe('string');
      vi.stubEnv('SSH_INTERACTIVE_ENABLED', 'false');
      await deniedTicket(interactiveTicket);
      await sql`update server_connections set data=data || '{"terminalMode":"readonly"}'::jsonb where id=${id}`;
      const ticket = (
        await send(1, `/api/servers/${id}/terminal-ticket`, 'POST', {
          confirmed: true,
        })
      ).json().ticket;
      const ws = await app.injectWS(`/api/servers/${id}/terminal`, {
        headers: { origin, cookie: `fafa_session=${sessions[1].raw}` },
        socket: { remoteAddress: '127.0.0.1' } as any,
      });
      const output = new Promise<string>((resolve, reject) => {
        ws.once('message', (data: Buffer) => resolve(data.toString()));
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ ticket, csrf: sessions[1].csrf }));
      expect(await output).toContain('fixture: uptime');
      ws.close();
      await sql`update server_connections set data=data || '{"fingerprint":"SHA256:wrong"}'::jsonb where id=${id}`;
      expect(
        (await send(1, `/api/servers/${id}/probe`, 'POST')).statusCode,
      ).toBe(409);
    } finally {
      fixture.close();
      vi.unstubAllEnvs();
    }
  });
  it('审计不可更新；禁用用户立即撤销访问', async () => {
    const [event] =
      await sql`select id from audit_events where owner_id=${ids[1]} limit 1`;
    await expect(
      sql`update audit_events set action='tamper' where id=${event.id}`,
    ).rejects.toThrow('append-only');
    expect(
      (await send(0, '/api/admin/users/' + ids[2], 'PATCH', { disabled: true }))
        .statusCode,
    ).toBe(200);
    expect((await send(2, '/api/me')).statusCode).toBe(401);
  });
  it('20 人席位并发激活与逐用户资源隔离', async () => {
    const [previous] =
      await sql`select value from settings where key='seat_limit'`;
    const [initial] =
      await sql`select count(*)::int as count from users where deleted_at is null`;
    expect(initial.count).toBeLessThan(20);
    await sql`update settings set value='20' where key='seat_limit'`;
    try {
      const contenders = Array.from({ length: 21 - initial.count }, () => ({
        sub: token(),
        email: token() + '@example.invalid',
        email_verified: true,
      }));
      for (const payload of contenders) {
        expect(
          (
            await send(0, '/api/admin/invitations', 'POST', {
              email: payload.email,
              role: 'Member',
            })
          ).statusCode,
        ).toBe(200);
      }
      const results = await Promise.allSettled(
        contenders.map((payload) => activateGoogle(payload)),
      );
      const accepted = results.filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<typeof activateGoogle>>
        > => r.status === 'fulfilled',
      );
      accepted.forEach((r) => ids.push(r.value.id as any));
      expect(accepted).toHaveLength(20 - initial.count);
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: 'SEAT_LIMIT' });
      const [count] =
        await sql`select count(*)::int as count from users where deleted_at is null`;
      expect(count.count).toBe(20);
      const participants = await Promise.all(
        accepted.map(async ({ value: user }) => {
          const session = await createSession(user);
          const headers = {
            origin,
            cookie: `fafa_session=${session.raw}`,
            'x-csrf-token': session.csrf,
          };
          const r = await app.inject({
            method: 'POST',
            url: '/api/location_presets',
            headers,
            payload: { name: '独立用户位置', latitude: 1, longitude: 2 },
          });
          expect(r.statusCode, r.body).toBe(200);
          return { user, headers, resourceId: r.json().id };
        }),
      );
      for (const participant of participants) {
        const own = await app.inject({
          url: '/api/location_presets/' + participant.resourceId,
          headers: participant.headers,
        });
        expect(own.statusCode).toBe(200);
        const reads = await Promise.all(
          participants
            .filter((p) => p.user.id !== participant.user.id)
            .map((other) =>
              app.inject({
                url: '/api/location_presets/' + other.resourceId,
                headers: participant.headers,
              }),
            ),
        );
        expect(reads.every((r) => r.statusCode === 404)).toBe(true);
        expect(
          (
            await app.inject({
              url: '/api/admin/users',
              headers: participant.headers,
            })
          ).statusCode,
        ).toBe(403);
      }
    } finally {
      await sql`update settings set value=${sql.json(previous.value)} where key='seat_limit'`;
    }
  });
  it('敏感操作再认证、会话撤销与审计脱敏', async () => {
    await sql`update sessions set reauthenticated_at=now()-interval '11 minutes' where owner_id=${ids[1]}`;
    expect((await send(1, '/api/subscription/rotate', 'POST')).statusCode).toBe(
      403,
    );
    const sourceWrite = await send(
      1,
      '/api/node_sources/' + sources[0],
      'PATCH',
      { name: '过期会话拒绝' },
    );
    expect(sourceWrite.statusCode).toBe(403);
    expect(sourceWrite.json().code).toBe('REAUTH_REQUIRED');
    await sql`update sessions set revoked_at=now() where owner_id=${ids[1]}`;
    expect((await send(1, '/api/me')).statusCode).toBe(401);
    const events =
      await sql`select action,target_id from audit_events where owner_id in ${sql(ids)}`;
    expect(JSON.stringify(events)).not.toMatch(
      /fixture-pass|sk-test-fixture|trojan:\/\//,
    );
  });
  it('跨 panel/admin 的 OIDC Cookie 范围、PKCE 与退出清理', async () => {
    vi.stubEnv('COOKIE_DOMAIN', '.fafa.test');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture-not-a-real-secret');
    try {
      const begin = await app.inject({
        url: '/auth/google',
        headers: { host: 'admin.fafa.test' },
      });
      expect(begin.statusCode).toBe(302);
      const cookie = begin.cookies.find((c) => c.name === 'fafa_oidc')!;
      expect(cookie.domain).toBe('.fafa.test');
      expect(cookie.httpOnly).toBe(true);
      const flow = JSON.parse(
        unseal(JSON.parse(Buffer.from(cookie.value, 'base64url').toString())),
      );
      const authorization = new URL(String(begin.headers.location));
      expect(authorization.searchParams.get('state')).toBe(flow.state);
      expect(authorization.searchParams.get('nonce')).toBe(flow.nonce);
      expect(authorization.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
      expect(authorization.searchParams.get('code_challenge')).toBe(
        Buffer.from(hash(flow.verifier), 'hex').toString('base64url'),
      );
      const callback = await app.inject({
        url: '/auth/google/callback?state=wrong&code=fixture',
        headers: {
          host: 'panel.fafa.test',
          cookie: 'fafa_oidc=' + cookie.value,
        },
      });
      expect(callback.statusCode).toBe(403);
      expect(callback.json().code).toBe('OIDC_STATE');
      expect(callback.cookies.find((c) => c.name === 'fafa_oidc')?.domain).toBe(
        '.fafa.test',
      );
      const logout = await send(3, '/api/logout', 'POST');
      expect(logout.statusCode).toBe(200);
      expect(
        logout.cookies.find((c) => c.name === 'fafa_session')?.domain,
      ).toBe('.fafa.test');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

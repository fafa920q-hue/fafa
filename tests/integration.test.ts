import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { Server as SshServer } from 'ssh2';
import { buildApp } from '../apps/api/src/server';
import { sql } from '../packages/db/src';
import { createSession, activateGoogle } from '../packages/auth/src';
import { token, seal } from '../packages/shared/src/crypto';
import { runAiTask, runSubscriptionJob } from '../apps/worker/src/jobs';
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
    const output = await app.inject(path + '?format=mihomo');
    expect(output.statusCode).toBe(200);
    expect(output.body).toContain('proxies:');
    expect(output.headers['cache-control']).toBe('no-store');
    await send(1, '/api/subscription/profile', 'PUT', { country: '美国' });
    expect((await app.inject(path + '?format=uri')).body).toBe('');
    await send(1, '/api/subscription/profile', 'PUT', { country: '' });
    await send(1, '/api/subscription/rotate', 'POST');
    expect((await app.inject(path)).statusCode).toBe(404);
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
    await sql`update sessions set revoked_at=now() where owner_id=${ids[1]}`;
    expect((await send(1, '/api/me')).statusCode).toBe(401);
    const events =
      await sql`select action,target_id from audit_events where owner_id in ${sql(ids)}`;
    expect(JSON.stringify(events)).not.toMatch(
      /fixture-pass|sk-test-fixture|trojan:\/\//,
    );
  });
});

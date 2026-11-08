import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '../packages/db/src';
import { seal } from '../packages/shared/src/crypto';
import { createSession } from '../packages/auth/src';
import { buildApp, visibleNodes } from '../apps/api/src/server';
let app: Awaited<ReturnType<typeof buildApp>>;
const users = [randomUUID(), randomUUID(), randomUUID()];
const sources = [randomUUID(), randomUUID()];
const nodes = [randomUUID(), randomUUID()];
const sessions: any[] = [];
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
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL!);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    !target.pathname.endsWith('_test')
  )
    throw Error('ISOLATED_DATABASE_REQUIRED');
  app = await buildApp();
  for (let i = 0; i < users.length; i++) {
    const [u] =
      await sql`INSERT INTO users(id,email,name,role,node_access_enabled,subscription_enabled,node_limit) VALUES(${users[i]},${randomUUID() + '@example.invalid'},${'v3_user_' + i},${i === 0 ? 'Owner' : 'Member'},false,true,20) RETURNING *`;
    sessions.push(await createSession(u as any));
  }
  for (let i = 0; i < 2; i++) {
    await sql`INSERT INTO node_sources(id,owner_id,data) VALUES(${sources[i]},${users[0]},${sql.json({ name: 'platform_' + i, kind: 'OWNED_NODE', authorized: true, enabled: true })})`;
    const node = {
      name: i ? 'other_permission_node' : 'allowed_permission_node',
      protocol: 'ss',
      host: '203.0.113.' + (i + 1),
      port: 443,
      credential: 'synthetic-not-real-password',
      cipher: 'aes-128-gcm',
      country: '日本',
      tls: false,
      transport: 'tcp',
    };
    await sql`INSERT INTO nodes(id,owner_id,source_id,data,secret) VALUES(${nodes[i]},${users[0]},${sources[i]},${sql.json({ name: node.name, protocol: node.protocol, country: '日本', enabled: true })},${sql.json(seal(JSON.stringify(node)))})`;
  }
});
afterAll(async () => {
  await sql`UPDATE users SET deleted_at=now() WHERE id IN ${sql(users)}`;
  await app.close();
  await sql.end();
});
it('匿名不能读取工作台或节点目录', async () => {
  expect((await app.inject('/api/workspace')).statusCode).toBe(401);
  expect((await app.inject('/api/catalog/nodes')).statusCode).toBe(401);
});
it('普通用户可以看公开元数据，但拿不到连接参数或订阅授权', async () => {
  const response = await send(1, '/api/catalog/nodes');
  expect(response.statusCode).toBe(200);
  const node = response.json().nodes.find((n: any) => n.id === nodes[0]);
  expect(node).toMatchObject({
    name: 'allowed_permission_node',
    authorized: false,
    canSubscribe: false,
    health: 'NOT_CHECKED',
    latency: null,
  });
  expect(Object.keys(node)).not.toContain('secret');
  expect(response.body).not.toContain('203.0.113.1');
  expect(response.body).not.toContain('synthetic-not-real-password');
});
it('工作台统计及活动只读取当前用户', async () => {
  const own = await send(1, '/api/workspace');
  expect(own.statusCode).toBe(200);
  expect(own.json().user.name).toBe('v3_user_1');
  expect(own.body).not.toContain('v3_user_2');
  expect(own.json().statistics.visibleNodes).toBeGreaterThanOrEqual(2);
  expect(own.json().statistics.aiAccounts).toBe(0);
  expect(own.json().user.emailVerified).toBe(false);
});
it('订阅授权后也不能自行添加或修改平台节点', async () => {
  await sql`UPDATE users SET node_access_enabled=true WHERE id=${users[1]}`;
  const privateImport = await send(1, '/api/node-import', 'POST', {
    name: 'legacy_private',
    kind: 'OWNED_NODE',
    authorized: true,
    content:
      'ss://aes-128-gcm:synthetic-private@203.0.113.45:443#legacy_private',
  });
  expect(privateImport.statusCode).toBe(200);
  expect(
    (await send(1, '/api/catalog/nodes'))
      .json()
      .nodes.some((n: any) => n.name === 'legacy_private'),
  ).toBe(false);
  expect(
    (
      await send(1, '/api/admin/grants', 'POST', {
        kind: 'source',
        resourceId: sources[0],
        userId: users[1],
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await send(1, '/api/nodes/' + nodes[0], 'PATCH', {
        catalogVisible: false,
      })
    ).statusCode,
  ).toBe(404);
});
it('单独授权、节点选择和订阅内容都维持资源隔离', async () => {
  await sql`INSERT INTO node_group_grants(owner_id,source_id,user_id,data) VALUES(${users[0]},${sources[0]},${users[1]},${sql.json({ scope: 'USE', expiresAt: new Date(Date.now() + 3600000).toISOString() })})`;
  const catalog = (await send(1, '/api/catalog/nodes')).json().nodes;
  expect(catalog.find((n: any) => n.id === nodes[0]).canSubscribe).toBe(true);
  expect(catalog.find((n: any) => n.id === nodes[1]).canSubscribe).toBe(false);
  expect(
    (await send(1, '/api/subscription/profile', 'PUT', { nodeIds: [...nodes] }))
      .statusCode,
  ).toBe(200);
  const visible = await visibleNodes(users[1]);
  expect(visible.map((n) => n.name)).toEqual(['allowed_permission_node']);
  const rotated = await send(1, '/api/subscription/rotate', 'POST', {});
  expect(rotated.statusCode).toBe(200);
  const path = new URL(rotated.json().url).pathname;
  const downloaded = await app.inject(path + '?format=uri');
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.body).toContain('allowed_permission_node');
  expect(downloaded.body).not.toContain('other_permission_node');
  expect(
    (await send(2, '/api/subscription/rotate', 'POST', {})).statusCode,
  ).toBe(403);
  await sql`UPDATE users SET node_access_until=now()-interval '1 second' WHERE id=${users[1]}`;
  expect((await app.inject(path + '?format=uri')).statusCode).toBe(403);
  const expired = (await send(1, '/api/catalog/nodes')).json().nodes;
  expect(expired.find((n: any) => n.id === nodes[0]).canSubscribe).toBe(false);
});
it('管理员隐藏节点后目录立即停止展示', async () => {
  expect(
    (
      await send(0, '/api/nodes/' + nodes[0], 'PATCH', {
        catalogVisible: false,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await send(1, '/api/catalog/nodes'))
      .json()
      .nodes.some((n: any) => n.id === nodes[0]),
  ).toBe(false);
});

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
  expect(privateImport.statusCode).toBe(403);
  expect(privateImport.json().code).toBe('ADMIN_NODE_MANAGEMENT');
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
  ).toBe(403);
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

it('全站开放按范围发放订阅，明确撤销、停用和旧令牌不会被活动覆盖', async () => {
  const target = users[2];
  const url = '/api/admin/access/users/' + target;
  const campaign = {
    enabled: true,
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    allMembers: false,
    userIds: [target],
    sourceIds: [sources[1]],
    services: { node: true, subscription: false, server: false, codex: false },
  };
  const updateCampaign = (patch: object) =>
    send(0, '/api/admin/access/campaign', 'PATCH', { ...campaign, ...patch });
  try {
    expect((await updateCampaign({})).statusCode).toBe(200);
    const catalog = (await send(2, '/api/catalog/nodes')).json().nodes;
    expect(catalog.find((n: any) => n.id === nodes[1])).toMatchObject({
      authorized: true,
      canSubscribe: false,
    });
    expect(
      (await send(2, '/api/subscription/rotate', 'POST', {})).statusCode,
    ).toBe(403);
    expect(
      (
        await updateCampaign({
          services: { ...campaign.services, subscription: true },
        })
      ).statusCode,
    ).toBe(200);
    const link = await send(2, '/api/subscription/rotate', 'POST', {});
    expect(link.statusCode).toBe(200);
    const path = new URL(link.json().url).pathname;
    expect((await app.inject(path + '?format=shadowrocket')).statusCode).toBe(
      200,
    );
    expect((await app.inject(path + '?format=v2rayn')).statusCode).toBe(200);
    expect((await send(1, url, 'PATCH', { disabled: true })).statusCode).toBe(
      403,
    );
    expect(
      (
        await send(0, '/api/admin/access/bulk', 'POST', {
          userIds: [target, users[0]],
          patch: { disabled: true },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject(path)).statusCode).toBe(200);
    expect(
      (await send(0, url, 'PATCH', { subscriptionEnabled: false })).statusCode,
    ).toBe(200);
    expect((await app.inject(path)).statusCode).toBe(404);
    expect(
      (
        await send(0, url, 'PATCH', {
          subscriptionEnabled: true,
          revokeSubscriptions: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(path)).statusCode).toBe(404);
    const replacement = await send(2, '/api/subscription/rotate', 'POST', {});
    expect(replacement.statusCode).toBe(200);
    const replacementPath = new URL(replacement.json().url).pathname;
    expect(
      (
        await updateCampaign({
          services: { ...campaign.services, subscription: true },
          paused: true,
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(replacementPath)).statusCode).toBe(403);
    expect((await send(0, url, 'PATCH', { disabled: true })).statusCode).toBe(
      200,
    );
    expect((await send(2, '/api/workspace')).statusCode).toBe(401);
    expect((await app.inject(replacementPath)).statusCode).toBe(404);
  } finally {
    await updateCampaign({ enabled: false });
    await sql`DELETE FROM settings WHERE key=${'business_access_' + target} OR key='service_policy_v3'`;
  }
});

it('用户级开关、单节点、多节点和整组分配分别控制目录、旧链接与跨用户访问', async () => {
  const createMember = async () => {
    const [u] =
      await sql`INSERT INTO users(email,name,role) VALUES(${randomUUID() + '@example.invalid'},'scoped assignment','Member') RETURNING *`;
    const index = users.push(u.id) - 1;
    sessions.push(await createSession(u as any));
    return index;
  };
  const member = await createMember(),
    other = await createMember();
  const sourceId = sources[1];
  const ids = [nodes[1], randomUUID(), randomUUID()];
  const labels = ['other_permission_node', 'second_in_group', 'outside_group'];
  await sql`UPDATE nodes SET data=data || '{"group":"test-selected-group"}'::jsonb WHERE id=${ids[0]}`;
  for (let i = 1; i < ids.length; i++) {
    const metadata = {
      name: labels[i],
      protocol: 'ss',
      country: '日本',
      group: i === 1 ? 'test-selected-group' : 'outside',
      enabled: true,
    };
    const node = {
      ...metadata,
      host: '203.0.113.' + (190 + i),
      port: 443,
      cipher: 'aes-128-gcm',
      credential: 'synthetic-only',
      tls: false,
      transport: 'tcp',
    };
    await sql`INSERT INTO nodes(id,owner_id,source_id,data,secret) VALUES(${ids[i]},${users[0]},${sourceId},${sql.json(metadata)},${sql.json(seal(JSON.stringify(node)))} )`;
  }
  const userPath = '/api/admin/access/users/' + users[member];
  const scopedGrant = (
    nodeIds: string[],
    groups: string[] = [],
    endsAt: string | null = null,
  ) => ({
    grants: [
      {
        kind: 'source',
        resourceId: sourceId,
        enabled: true,
        nodeScope: { nodeIds, groups },
        endsAt,
      },
    ],
  });
  const catalog = async (index: number) =>
    (await send(index, '/api/catalog/nodes'))
      .json()
      .nodes.filter((row: any) => ids.includes(row.id));
  const subscribed = async (index: number) =>
    (await catalog(index))
      .filter((row: any) => row.canSubscribe)
      .map((row: any) => row.name)
      .sort();
  for (const index of [member, other]) {
    expect(
      (
        await send(0, '/api/admin/access/users/' + users[index], 'PATCH', {
          node: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
  }
  expect(await subscribed(member)).toEqual([]);
  const missing = await send(member, '/api/subscription/rotate', 'POST', {});
  expect(missing.statusCode).toBe(403);
  expect(missing.json().code).toBe('NO_SUBSCRIPTION_NODES');
  const invalid = await send(0, userPath, 'PATCH', scopedGrant([nodes[0]]));
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().code).toBe('NODE_SCOPE_INVALID');
  expect(
    (await send(member, userPath, 'PATCH', scopedGrant([ids[0]]))).statusCode,
  ).toBe(403);

  expect(
    (await send(0, userPath, 'PATCH', scopedGrant([ids[0]]))).statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([labels[0]]);
  expect(await subscribed(other)).toEqual([]);
  expect(
    (await send(member, '/api/nodes')).json().map((row: any) => row.id),
  ).toEqual([ids[0]]);
  expect(
    (
      await send(0, '/api/admin/grants', 'POST', {
        kind: 'source',
        resourceId: sourceId,
        userId: users[member],
      })
    ).statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([labels[0]]);

  const rotation = await send(member, '/api/subscription/rotate', 'POST', {});
  expect(rotation.statusCode).toBe(200);
  const path = new URL(rotation.json().url).pathname + '?format=uri';
  const exported = async () => (await app.inject(path)).body;
  expect(await exported()).toContain(labels[0]);
  expect(await exported()).not.toContain(labels[1]);
  expect(
    (await send(0, userPath, 'PATCH', scopedGrant([ids[0], ids[2]])))
      .statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([labels[0], labels[2]].sort());
  expect(await exported()).toContain(labels[2]);

  expect(
    (await send(0, userPath, 'PATCH', scopedGrant([], ['test-selected-group'])))
      .statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([labels[0], labels[1]].sort());
  expect(await exported()).toContain(labels[1]);
  expect(await exported()).not.toContain(labels[2]);
  expect(
    (
      await send(
        0,
        userPath,
        'PATCH',
        scopedGrant([ids[0]], [], new Date(Date.now() - 1000).toISOString()),
      )
    ).statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([]);
  expect(await exported()).toBe('');

  expect(
    (
      await send(0, userPath, 'PATCH', {
        ...scopedGrant([ids[0]]),
        subscriptionEnabled: false,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await catalog(member)).find((row: any) => row.id === ids[0]),
  ).toMatchObject({ authorized: true, canSubscribe: false });
  expect(
    (await send(member, '/api/subscription/rotate', 'POST', {})).statusCode,
  ).toBe(403);
  expect(
    (await send(0, userPath, 'PATCH', { subscriptionEnabled: true }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await send(0, userPath, 'PATCH', {
        grants: [{ kind: 'source', resourceId: sourceId, enabled: false }],
      })
    ).statusCode,
  ).toBe(200);
  expect(await subscribed(member)).toEqual([]);
  expect(await exported()).toBe('');
  expect(await subscribed(other)).toEqual([]);
});

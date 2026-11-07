import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { AppError, notFound } from '../../../packages/shared/src';
import {
  readAutoGrantPolicy,
  autoGrantPolicySchema,
  backfillAutoGrants,
} from './auto-grant';
export async function registerAdmin(app: FastifyInstance) {
  app.get('/api/admin/users', async () =>
    (
      await sql`select id,name,email,role,disabled,node_limit,subscription_enabled,server_connect_enabled,codex_tasks_enabled,traffic_limit_bytes,created_at from users where deleted_at is null order by created_at`
    ).map((user) => ({
      ...user,
      serverConnectEnabled: user.server_connect_enabled,
      codexTasksEnabled: user.codex_tasks_enabled,
      trafficLimitBytes:
        user.traffic_limit_bytes === null
          ? null
          : Number(user.traffic_limit_bytes),
      trafficUsageBytes: null,
      trafficMeteringStatus: 'UNAVAILABLE',
      trafficQuotaEnforcement: 'NOT_ACTIVE',
    })),
  );
  app.get(
    '/api/admin/invitations',
    async () =>
      sql`select id,data,created_at,revoked_at from invitations order by created_at desc`,
  );
  app.post('/api/admin/invitations', async (req) => {
    const d = z
      .object({
        email: z.email(),
        role: z.enum(['Admin', 'Member', 'Viewer']),
        days: z.number().int().min(1).max(30).default(7),
      })
      .parse(req.body);
    if (d.role === 'Admin' && req.actor.role !== 'Owner')
      throw new AppError(403, 'OWNER_REQUIRED', '仅 Owner 可邀请管理员');
    const data = {
      email: d.email.toLowerCase(),
      role: d.role,
      expiresAt: new Date(Date.now() + d.days * 86400000).toISOString(),
    };
    const [r] =
      await sql`insert into invitations(owner_id,data) values(${req.actor.id},${sql.json(data)}) returning id,data`;
    await audit(req.actor.id, 'invitation.created', r.id);
    return r;
  });
  app.delete('/api/admin/invitations/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await sql`update invitations set revoked_at=now() where id=${id}`;
    await audit(req.actor.id, 'invitation.revoked', id);
    return { ok: true };
  });
  app.patch('/api/admin/users/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const d = z
      .object({
        disabled: z.boolean().optional(),
        role: z.enum(['Admin', 'Member', 'Viewer']).optional(),
        revokeSessions: z.boolean().optional(),
        nodeLimit: z.number().int().min(0).max(5000).optional(),
        subscriptionEnabled: z.boolean().optional(),
        serverConnectEnabled: z.boolean().optional(),
        codexTasksEnabled: z.boolean().optional(),
        trafficLimitBytes: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .nullable()
          .optional(),
      })
      .parse(req.body);
    const [u] = await sql`select * from users where id=${id}`;
    if (!u) throw notFound();
    if (
      u.role === 'Owner' ||
      id === req.actor.id ||
      (d.role && req.actor.role !== 'Owner') ||
      (u.role === 'Admin' && req.actor.role !== 'Owner')
    )
      throw new AppError(403, 'OWNER_PROTECTED', '不允许修改此账户或角色');
    await sql.begin(async (tx) => {
      await tx`update users set disabled=${d.disabled ?? u.disabled},role=${d.role ?? u.role},node_limit=${d.nodeLimit ?? u.node_limit},subscription_enabled=${d.subscriptionEnabled ?? u.subscription_enabled},server_connect_enabled=${d.serverConnectEnabled ?? u.server_connect_enabled},codex_tasks_enabled=${d.codexTasksEnabled ?? u.codex_tasks_enabled},traffic_limit_bytes=${d.trafficLimitBytes === undefined ? u.traffic_limit_bytes : d.trafficLimitBytes},updated_at=now() where id=${id}`;
      if (d.disabled || d.revokeSessions || d.role)
        await tx`update sessions set revoked_at=now() where owner_id=${id}`;
    });
    await audit(req.actor.id, 'user.updated', id);
    return { ok: true };
  });
  for (const [route, table] of [
    ['sources', 'node_sources'],
    ['servers', 'server_connections'],
    ['ai', 'ai_accounts'],
    ['jobs', 'background_jobs'],
    ['audit', 'audit_events'],
  ] as const) {
    app.get(`/api/admin/${route}`, async () =>
      table === 'audit_events'
        ? sql`select id,owner_id,action,target_id,correlation_id,created_at from audit_events order by created_at desc limit 200`
        : sql`select id,owner_id,data,created_at from ${sql(table)} where revoked_at is null order by created_at desc limit 200`,
    );
  }
  app.get('/api/admin/grants', async (req) => {
    const sources =
      await sql`select g.id,g.source_id as "resourceId",g.user_id as "userId" from node_group_grants g join node_sources s on s.id=g.source_id where s.owner_id=${req.actor.id} and s.revoked_at is null and g.revoked_at is null`;
    const servers =
      await sql`select g.id,g.server_id as "resourceId",g.user_id as "userId" from server_access_grants g join server_connections s on s.id=g.server_id where s.owner_id=${req.actor.id} and s.revoked_at is null and g.revoked_at is null`;
    return [
      ...sources.map((grant) => ({ ...grant, kind: 'source' })),
      ...servers.map((grant) => ({ ...grant, kind: 'server' })),
    ];
  });
  app.post('/api/admin/grants', async (req) => {
    const { kind, resourceId, userId } = z
      .object({
        kind: z.enum(['source', 'server']),
        resourceId: z.uuid(),
        userId: z.uuid(),
      })
      .parse(req.body);
    const table = kind === 'source' ? 'node_sources' : 'server_connections';
    const [r] =
      await sql`select id,data from ${sql(table)} where id=${resourceId} and owner_id=${req.actor.id} and revoked_at is null`;
    if (!r) throw notFound();
    const [user] =
      await sql`select id from users where id=${userId} and not disabled and deleted_at is null`;
    if (!user) throw notFound();
    if (
      kind === 'source' &&
      r.data.kind !== 'OWNED_NODE' &&
      (r.data.authorized !== true ||
        r.data.redistributionAuthorized !== true ||
        !r.data.authorizationReference?.trim())
    )
      throw new AppError(
        403,
        'REDISTRIBUTION_REQUIRED',
        '第三方节点必须确认再分发授权',
      );
    const grant =
      kind === 'source' ? 'node_group_grants' : 'server_access_grants';
    const fk = kind === 'source' ? 'source_id' : 'server_id';
    await sql`insert into ${sql(grant)}(owner_id,${sql(fk)},user_id,data) values(${req.actor.id},${resourceId},${userId},${sql.json({ scope: 'USE' })}) on conflict do nothing`;
    await audit(req.actor.id, 'grant.created', resourceId);
    return { ok: true };
  });
  app.delete('/api/admin/grants/:kind/:id/:userId', async (req) => {
    const { kind, id, userId } = z
      .object({
        kind: z.enum(['source', 'server']),
        id: z.uuid(),
        userId: z.uuid(),
      })
      .parse(req.params);
    const table =
        kind === 'source' ? 'node_group_grants' : 'server_access_grants',
      fk = kind === 'source' ? 'source_id' : 'server_id';
    await sql`update ${sql(table)} set revoked_at=now() where ${sql(fk)}=${id} and user_id=${userId} and owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'grant.revoked', id);
    return { ok: true };
  });
  app.get('/api/admin/settings', async () => ({
    settings: await sql`select key,value from settings`,
    capabilities: {
      google: !!process.env.GOOGLE_CLIENT_ID,
      ssh: !!process.env.SSH_ALLOWED_TARGETS,
      chatgpt: '暂未开放',
      gps: '暂不支持',
      backup: '请使用离线加密备份脚本',
    },
  }));
  app.patch('/api/admin/settings', async (req) => {
    if (req.actor.role !== 'Owner')
      throw new AppError(403, 'OWNER_REQUIRED', '仅 Owner 可修改系统设置');
    const { seatLimit } = z
      .object({ seatLimit: z.number().int().min(1).max(1000) })
      .parse(req.body);
    await sql`update settings set value=${sql.json(seatLimit)},updated_at=now() where key='seat_limit'`;
    await audit(req.actor.id, 'settings.updated');
    return { ok: true };
  });
  app.post('/api/admin/jobs/:id/retry', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await sql`update background_jobs set data=data || ${sql.json({ status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })} where id=${id} and data->>'status'='FAILED'`;
    await audit(req.actor.id, 'job.retried', id);
    return { ok: true };
  });
  // 新用户前三天自动授权策略（管理后台配置、记录与补处理）。
  // 授权本身复用 node_group_grants / subscription_tokens；服务器一步只开
  // “连接自己的服务器”功能资格，不授予任何指定服务器行访问。
  app.get('/api/admin/auto-grant/policy', async () => readAutoGrantPolicy());
  app.patch('/api/admin/auto-grant/policy', async (req) => {
    if (req.actor.role !== 'Owner')
      throw new AppError(403, 'OWNER_REQUIRED', '仅 Owner 可修改自动授权策略');
    const policy = autoGrantPolicySchema.parse(req.body);
    if (policy.nodeSourceId) {
      const [source] =
        await sql`select id from node_sources where id=${policy.nodeSourceId} and owner_id=${req.actor.id} and revoked_at is null`;
      if (!source)
        throw new AppError(
          400,
          'NODE_SOURCE_NOT_FOUND',
          '指定的免费节点组不存在或不属于当前管理员',
        );
    }
    await sql.begin(async (tx) => {
      for (const [key, value] of [
        ['auto_grant_enabled', policy.enabled],
        ['auto_grant_window_start', policy.windowStart],
        ['auto_grant_window_end', policy.windowEnd],
        ['auto_grant_node_source_id', policy.nodeSourceId],
        ['auto_grant_node_limit', policy.nodeLimit],
        ['auto_grant_trial_valid_days', policy.trialValidDays],
      ] as const) {
        await tx`insert into settings(key,value) values(${key},${tx.json(value)}) on conflict (key) do update set value=excluded.value,updated_at=now()`;
      }
    });
    await audit(req.actor.id, 'auto_grant.policy.updated');
    return { ok: true, policy };
  });
  app.get('/api/admin/auto-grant/records', async (req) => {
    const q = z
      .object({
        userId: z.uuid().optional(),
        status: z.enum(['GRANTED', 'PENDING', 'FAILED']).optional(),
        kind: z.enum(['node', 'server', 'token']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    // postgres 模板参数不接受 undefined：未传的过滤条件统一转为 null，
    // 使 `null::uuid is null` / `null::text is null` 成立，跳过该过滤项。
    // 直接传 undefined 不仅通不过类型检查，运行时也会被 postgres 拒绝。
    const userId = q.userId ?? null;
    const status = q.status ?? null;
    const kind = q.kind ?? null;
    return sql`select r.id,r.user_id,r.kind,r.resource_id,r.status,r.reason,r.expires_at,r.granted_at,r.created_at,u.email,u.name from auto_grant_records r join users u on u.id=r.user_id where (${userId}::uuid is null or r.user_id=${userId}) and (${status}::text is null or r.status=${status}) and (${kind}::text is null or r.kind=${kind}) order by r.created_at desc limit ${q.limit}`;
  });
  app.post('/api/admin/auto-grant/backfill', async (req) => {
    if (req.actor.role !== 'Owner')
      throw new AppError(
        403,
        'OWNER_REQUIRED',
        '仅 Owner 可执行自动授权补处理',
      );
    return backfillAutoGrants(req.actor.id);
  });
}

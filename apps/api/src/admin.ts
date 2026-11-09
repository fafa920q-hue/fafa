import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import {
  aiQuotaSchema,
  readServicePolicy,
  servicePolicySchema,
  readAiQuota,
} from '../../../packages/auth/src/service-policy';
import { AppError, notFound } from '../../../packages/shared/src';
import {
  memberPolicySchema,
  readSetting,
  resolveAccess,
  writeSetting,
} from '../../../packages/auth/src/business-access';
export async function registerAdmin(app: FastifyInstance) {
  app.get('/api/admin/service-policy', async () => readServicePolicy());
  app.patch('/api/admin/service-policy', async (req) => {
    if (req.actor.role !== 'Owner')
      throw new AppError(403, 'OWNER_REQUIRED', '仅 Owner 可修改全站服务策略');
    const policy = servicePolicySchema.parse(req.body);
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(77704)`;
      const current = await readServicePolicy(tx);
      if (current.schedule.mode === 'TEMPORARY_GRANT')
        policy.schedule = current.schedule;
      if (policy.ai.enabled) {
        const [account] =
          await tx`SELECT id FROM ai_accounts WHERE id=${policy.ai.accountId} AND owner_id=${req.actor.id} AND revoked_at IS NULL AND secret IS NOT NULL FOR UPDATE`;
        if (!account)
          throw new AppError(
            400,
            'AI_UNCONFIGURED',
            '请选择本人已配置凭据的 API 账户',
          );
      }
      await tx`INSERT INTO settings(key,value) VALUES('service_policy_v3',${tx.json(policy)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${req.actor.id},'service.policy_updated',${JSON.stringify(policy)})`;
    });
    return { ok: true };
  });
  app.get('/api/admin/users/:id/ai-quota', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return readAiQuota(id);
  });
  app.patch('/api/admin/users/:id/ai-quota', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const quota = aiQuotaSchema.parse(req.body);
    await sql.begin(async (tx) => {
      const [user] =
        await tx`SELECT role FROM users WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
      if (!user || user.role !== 'Member')
        throw new AppError(403, 'MEMBER_REQUIRED', '额度管理仅适用于普通用户');
      await tx`INSERT INTO settings(key,value) VALUES(${'ai_quota_' + id},${tx.json(quota)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${req.actor.id},'ai.quota_updated',${JSON.stringify({ userId: id, ...quota })})`;
    });
    return { ok: true };
  });
  app.get('/api/admin/users', async () =>
    Promise.all(
      (
        await sql`select u.id,u.name,u.email,u.role,u.disabled,u.node_limit,u.subscription_enabled,u.traffic_limit_bytes,u.created_at,u.node_access_enabled,u.node_access_until,u.server_connect_enabled,u.server_connect_until,u.codex_tasks_enabled,u.codex_tasks_until,(exists(select 1 from member_credentials c where c.user_id=u.id) or exists(select 1 from google_identities g where g.user_id=u.id)) as email_verified from users u where u.deleted_at is null order by u.created_at`
      ).map(async (row) => {
        const user = await resolveAccess(row);
        return {
          ...user,
          capabilities: {
            node: capabilityAllowed(user, 'node'),
            server: capabilityAllowed(user, 'server'),
            codex: capabilityAllowed(user, 'codex'),
          },
          trafficLimitBytes:
            user.traffic_limit_bytes === null
              ? null
              : Number(user.traffic_limit_bytes),
          trafficUsageBytes: user._access.traffic.bytes,
          trafficMeteringStatus: user._access.traffic.status,
          trafficQuotaEnforcement: user._access.traffic.enforcement,
        };
      }),
    ),
  );
  app.get(
    '/api/admin/invitations',
    async () =>
      sql`select id,data,created_at,revoked_at from invitations order by created_at desc`,
  );
  app.post('/api/admin/invitations', async (req) => {
    if (process.env.MEMBER_SELF_SERVICE === 'true')
      throw new AppError(
        409,
        'INVITATIONS_RETIRED',
        '已改为用户自行注册，不再创建邀请',
      );
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
        nodeAccessEnabled: z.boolean().optional(),
        serverConnectEnabled: z.boolean().optional(),
        codexTasksEnabled: z.boolean().optional(),
        disabled: z.boolean().optional(),
        role: z.enum(['Admin', 'Member', 'Viewer']).optional(),
        revokeSessions: z.boolean().optional(),
        nodeLimit: z.number().int().min(0).max(5000).optional(),
        subscriptionEnabled: z.boolean().optional(),
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
      u.role !== 'Member' &&
      [d.nodeAccessEnabled, d.serverConnectEnabled, d.codexTasksEnabled].some(
        (value) => value !== undefined,
      )
    )
      throw new AppError(
        403,
        'MEMBER_CAPABILITY_ONLY',
        '功能开关适用于 Member；管理角色与只读访客继续使用原角色权限',
      );
    if (
      u.role === 'Owner' ||
      id === req.actor.id ||
      (d.role && req.actor.role !== 'Owner') ||
      (u.role === 'Admin' && req.actor.role !== 'Owner')
    )
      throw new AppError(403, 'OWNER_PROTECTED', '不允许修改此账户或角色');
    await sql.begin(async (tx) => {
      const [live] = await tx`SELECT * FROM users WHERE id=${id} FOR UPDATE`;
      if (
        !live ||
        live.role === 'Owner' ||
        (live.role === 'Admin' && req.actor.role !== 'Owner')
      )
        throw new AppError(403, 'OWNER_PROTECTED', '不允许修改受保护账户');
      const policy = memberPolicySchema.parse(
        (await readSetting('business_access_' + id, tx)) || {},
      );
      const deny = new Set(policy.deny);
      for (const [kind, key] of [
        ['node', 'nodeAccessEnabled'],
        ['server', 'serverConnectEnabled'],
        ['codex', 'codexTasksEnabled'],
        ['subscription', 'subscriptionEnabled'],
      ] as const) {
        if (d[key] === false) deny.add(kind);
        else if (d[key] === true) deny.delete(kind);
      }
      policy.deny = [...deny];
      if (d.nodeLimit !== undefined) policy.nodeCeiling = d.nodeLimit;
      await writeSetting('business_access_' + id, policy, tx);
      await tx`update users set disabled=${d.disabled ?? live.disabled},role=${d.role ?? live.role},node_limit=${d.nodeLimit ?? live.node_limit},subscription_enabled=${d.subscriptionEnabled ?? live.subscription_enabled},traffic_limit_bytes=${d.trafficLimitBytes === undefined ? live.traffic_limit_bytes : d.trafficLimitBytes},updated_at=now() where id=${id}`;
      for (const [key, column, expiry] of [
        ['nodeAccessEnabled', 'node_access_enabled', 'node_access_until'],
        [
          'serverConnectEnabled',
          'server_connect_enabled',
          'server_connect_until',
        ],
        ['codexTasksEnabled', 'codex_tasks_enabled', 'codex_tasks_until'],
      ] as const) {
        if (d[key] !== undefined)
          await tx.unsafe(
            'UPDATE users SET ' +
              column +
              '=$2,' +
              expiry +
              '=NULL WHERE id=$1',
            [id, d[key]!],
          );
      }
      if (
        d.nodeAccessEnabled !== undefined ||
        d.serverConnectEnabled !== undefined ||
        d.codexTasksEnabled !== undefined
      )
        await tx.unsafe(
          "INSERT INTO audit_events(owner_id,action,target_id) VALUES($1,'member.capabilities_updated',$2)",
          [
            req.actor.id,
            JSON.stringify({
              userId: id,
              source: 'ADMIN',
              startsAt: new Date().toISOString(),
              endsAt: null,
              node: d.nodeAccessEnabled,
              server: d.serverConnectEnabled,
              codex: d.codexTasksEnabled,
            }),
          ],
        );
      if (d.disabled || d.revokeSessions || d.role) {
        await tx`update sessions set revoked_at=now() where owner_id=${id}`;
        await tx.unsafe(
          'UPDATE member_action_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
          [id],
        );
        await tx.unsafe(
          'UPDATE member_google_links SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
          [id],
        );
      }
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
    await sql`insert into ${sql(grant)}(owner_id,${sql(fk)},user_id,data) values(${req.actor.id},${resourceId},${userId},${sql.json({ scope: 'USE', grantSource: 'ADMIN', startsAt: new Date().toISOString(), endsAt: null })}) on conflict (${sql(fk)},user_id) where revoked_at is null do update set data=case when ${sql(grant)}.data ? 'nodeScope' then ${sql(grant)}.data else excluded.data end,updated_at=now()`;
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
}

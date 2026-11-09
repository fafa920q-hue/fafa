import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../../../packages/db/src';
import { AppError } from '../../../packages/shared/src';
import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import { activeGrant, defaultTrialPolicy, memberPolicySchema, readSetting, resolveAccess, trialPolicySchema, writeSetting } from '../../../packages/auth/src/business-access';
import { readServicePolicy, servicePolicySchema } from '../../../packages/auth/src/service-policy';

const grantSchema = z.object({ kind: z.enum(['source', 'server']), resourceId: z.uuid(), enabled: z.boolean(), endsAt: z.iso.datetime().nullable().default(null) });
const capabilityPatch = z.object({ enabled: z.boolean(), until: z.iso.datetime().nullable().default(null) });
export const accessPatchSchema = z.object({
  disabled: z.boolean().optional(),
  node: capabilityPatch.optional(), server: capabilityPatch.optional(), codex: capabilityPatch.optional(),
  subscriptionEnabled: z.boolean().optional(), nodeLimit: z.number().int().min(0).max(5000).optional(),
  trafficLimitBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  policy: memberPolicySchema.partial().optional(),
  aiQuota: z.object({ dailyLimit: z.number().int().min(0).max(1000), concurrency: z.number().int().min(1).max(10) }).optional(),
  grants: z.array(grantSchema).max(100).default([]),
  revokeSessions: z.boolean().default(false), revokeSubscriptions: z.boolean().default(false), revokeTrial: z.boolean().default(false),
}).strict();

async function platformResource(kind: 'source' | 'server', id: string, db: any = sql) {
  const table = kind === 'source' ? 'node_sources' : 'server_connections';
  const [r] = await db`SELECT r.id,r.owner_id,r.data FROM ${db(table)} r JOIN users u ON u.id=r.owner_id WHERE r.id=${id} AND r.revoked_at IS NULL AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.deleted_at IS NULL`;
  if (!r) throw new AppError(404, 'PLATFORM_RESOURCE_REQUIRED', '资源不存在或不属于管理员可分配的平台资源');
  if (kind === 'source' && (r.data.demo || r.data.enabled === false || !activeGrant({ expiresAt: r.data.expiresAt }) || (r.data.kind !== 'OWNED_NODE' && !(r.data.authorized === true && r.data.redistributionAuthorized === true && r.data.authorizationReference?.trim()))))
    throw new AppError(403, 'SOURCE_NOT_AUTHORIZED', '节点源不可用或缺少合法再分发授权');
  return r;
}
export async function validateActivitySources(sourceIds: string[], db: any = sql) {
  for (const id of sourceIds) await platformResource('source', id, db);
}
async function changeAccess(actor: any, ids: string[], patch: z.infer<typeof accessPatchSchema>) {
  return sql.begin(async (tx) => {
    const sorted = [...new Set(ids)].sort();
    const users = await tx`SELECT * FROM users WHERE id IN ${tx(sorted)} ORDER BY id FOR UPDATE`;
    if (users.length !== sorted.length || users.some((u) => u.role !== 'Member' || u.deleted_at || u.id === actor.id))
      throw new AppError(403, 'MEMBER_SCOPE_REQUIRED', '只能修改有效普通用户；整批包含受保护账户时不执行任何变更');
    const resources = new Map<string, any>();
    for (const grant of patch.grants) resources.set(grant.kind + grant.resourceId, await platformResource(grant.kind, grant.resourceId, tx));
    if (patch.policy?.allowedSourceIds) await validateActivitySources(patch.policy.allowedSourceIds, tx);
    if (patch.policy?.allowedServerIds) for (const id of patch.policy.allowedServerIds) await platformResource('server', id, tx);
    for (const u of users) {
      const previous = memberPolicySchema.parse((await readSetting('business_access_' + u.id, tx)) || {});
      const policy = { ...previous, ...patch.policy };
      const denied = new Set(policy.deny);
      for (const [kind, column] of [['node', 'node_access'], ['server', 'server_connect'], ['codex', 'codex_tasks']] as const) {
        const change = patch[kind];
        if (!change) continue;
        await tx`UPDATE users SET ${tx(column + '_enabled')}=${change.enabled},${tx(column + '_until')}=${change.until},updated_at=now() WHERE id=${u.id}`;
        if (change.enabled) denied.delete(kind); else denied.add(kind);
      }
      if (patch.subscriptionEnabled !== undefined) {
        await tx`UPDATE users SET subscription_enabled=${patch.subscriptionEnabled},updated_at=now() WHERE id=${u.id}`;
        if (patch.subscriptionEnabled) denied.delete('subscription'); else denied.add('subscription');
      }
      policy.deny = [...denied];
      if (patch.nodeLimit !== undefined) {
        policy.nodeCeiling = patch.nodeLimit;
        await tx`UPDATE users SET node_limit=${patch.nodeLimit},updated_at=now() WHERE id=${u.id}`;
      }
      if (patch.trafficLimitBytes !== undefined) await tx`UPDATE users SET traffic_limit_bytes=${patch.trafficLimitBytes},updated_at=now() WHERE id=${u.id}`;
      if (patch.disabled !== undefined) await tx`UPDATE users SET disabled=${patch.disabled},updated_at=now() WHERE id=${u.id}`;
      await writeSetting('business_access_' + u.id, memberPolicySchema.parse(policy), tx);
      if (patch.aiQuota) await writeSetting('ai_quota_' + u.id, patch.aiQuota, tx);
      for (const grant of patch.grants) {
        const resource = resources.get(grant.kind + grant.resourceId), table = grant.kind === 'source' ? 'node_group_grants' : 'server_access_grants', fk = grant.kind === 'source' ? 'source_id' : 'server_id';
        if (grant.enabled) {
          await tx`INSERT INTO ${tx(table)}(owner_id,${tx(fk)},user_id,data) VALUES(${resource.owner_id},${resource.id},${u.id},${tx.json({ scope: 'USE', grantSource: 'ADMIN', startsAt: new Date().toISOString(), endsAt: grant.endsAt })}) ON CONFLICT(${tx(fk)},user_id) WHERE revoked_at IS NULL DO UPDATE SET data=excluded.data,updated_at=now()`;
          if (grant.kind === 'source') policy.deniedSourceIds = policy.deniedSourceIds.filter((id) => id !== resource.id);
          else policy.deniedServerIds = policy.deniedServerIds.filter((id) => id !== resource.id);
        } else {
          await tx`UPDATE ${tx(table)} SET revoked_at=now(),updated_at=now() WHERE ${tx(fk)}=${resource.id} AND user_id=${u.id} AND revoked_at IS NULL`;
          // Explicit resource revocation also blocks temporary activity grants.
          if (grant.kind === 'source') policy.deniedSourceIds = [...new Set([...policy.deniedSourceIds, resource.id])];
          else policy.deniedServerIds = [...new Set([...policy.deniedServerIds, resource.id])];
        }
      }
      await writeSetting('business_access_' + u.id, policy, tx);
      if (patch.revokeSessions || patch.disabled === true) {
        await tx`UPDATE sessions SET revoked_at=now() WHERE owner_id=${u.id} AND revoked_at IS NULL`;
        await tx`UPDATE member_action_tokens SET consumed_at=now() WHERE user_id=${u.id} AND consumed_at IS NULL`;
        await tx`UPDATE member_google_links SET consumed_at=now() WHERE user_id=${u.id} AND consumed_at IS NULL`;
      }
      if (patch.revokeSubscriptions) await tx`UPDATE subscription_tokens SET revoked_at=now() WHERE owner_id=${u.id} AND revoked_at IS NULL`;
      if (patch.revokeTrial) {
        const trial = await readSetting('trial_entitlement_' + u.id, tx);
        if (trial) await writeSetting('trial_entitlement_' + u.id, { ...trial, endsAt: new Date().toISOString(), revokedBy: actor.id }, tx);
      }
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${actor.id},'access.member_updated',${JSON.stringify({ userId: u.id, patch, batchSize: users.length })})`;
    }
    return { updated: users.length };
  });
}

export async function registerAccessCenter(app: FastifyInstance) {
  app.get('/api/admin/access/resources', async () => ({
    sources: await sql`SELECT s.id,s.owner_id,s.data->>'name' AS name,s.data->>'group' AS "group",s.data->>'kind' AS kind FROM node_sources s JOIN users u ON u.id=s.owner_id WHERE s.revoked_at IS NULL AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.deleted_at IS NULL ORDER BY s.created_at`,
    groups: (await sql`SELECT DISTINCT coalesce(n.data->>'group',s.data->>'group','') AS name FROM nodes n JOIN node_sources s ON s.id=n.source_id JOIN users u ON u.id=s.owner_id WHERE n.revoked_at IS NULL AND s.revoked_at IS NULL AND u.role IN ('Owner','Admin')`).map((r) => r.name).filter(Boolean),
    servers: await sql`SELECT s.id,s.data->>'name' AS name FROM server_connections s JOIN users u ON u.id=s.owner_id WHERE s.revoked_at IS NULL AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.deleted_at IS NULL`,
    aiAccounts: await sql`SELECT a.id,a.data->>'name' AS name,a.data->>'status' AS status FROM ai_accounts a JOIN users u ON u.id=a.owner_id WHERE a.revoked_at IS NULL AND u.role IN ('Owner','Admin') AND NOT u.disabled AND u.deleted_at IS NULL`,
  }));
  app.get('/api/admin/access/users', async () => {
    const users = await sql`SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 500`;
    return Promise.all(users.map(async (u) => {
      const user = await resolveAccess(u);
      return { id: u.id, name: u.name, email: u.email, role: u.role, disabled: u.disabled,
        base: { node: u.node_access_enabled, server: u.server_connect_enabled, codex: u.codex_tasks_enabled, nodeUntil: u.node_access_until, serverUntil: u.server_connect_until, codexUntil: u.codex_tasks_until, subscriptionEnabled: u.subscription_enabled, nodeLimit: u.node_limit, trafficLimitBytes: u.traffic_limit_bytes == null ? null : Number(u.traffic_limit_bytes) },
        effective: user._access.capabilities, policy: user._access.policy, overlays: user._access.overlays, traffic: user._access.traffic, aiQuota: user._access.aiQuota,
        grants: { sources: await sql`SELECT source_id AS id,data FROM node_group_grants WHERE user_id=${u.id} AND revoked_at IS NULL`, servers: await sql`SELECT server_id AS id,data FROM server_access_grants WHERE user_id=${u.id} AND revoked_at IS NULL` },
      };
    }));
  });
  app.patch('/api/admin/access/users/:id', async (req) => changeAccess(req.actor, [z.object({ id: z.uuid() }).parse(req.params).id], accessPatchSchema.parse(req.body)));
  app.post('/api/admin/access/bulk', async (req) => {
    const data = z.object({ userIds: z.array(z.uuid()).min(1).max(100), patch: accessPatchSchema }).strict().parse(req.body);
    return changeAccess(req.actor, data.userIds, data.patch);
  });
  app.get('/api/admin/access/trial-policy', async () => (await readSetting('registration_trial_v3')) || defaultTrialPolicy);
  app.patch('/api/admin/access/trial-policy', async (req) => {
    const policy = trialPolicySchema.parse(req.body);
    return sql.begin(async (tx) => {
      await validateActivitySources(policy.sourceIds, tx);
      await writeSetting('registration_trial_v3', policy, tx);
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${req.actor.id},'trial.policy_updated',${JSON.stringify(policy)})`;
      return { ok: true };
    });
  });
  app.get('/api/admin/access/trials', async () => (await sql`SELECT key,value FROM settings WHERE key LIKE 'trial_entitlement_%' ORDER BY updated_at DESC LIMIT 200`).map((r) => ({ userId: r.key.slice('trial_entitlement_'.length), ...r.value, active: activeGrant(r.value) })));
  app.get('/api/admin/access/campaign', async () => (await readServicePolicy()).schedule);
  app.patch('/api/admin/access/campaign', async (req) => {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(77704)`;
      const policy = await readServicePolicy(tx);
      const schedule = servicePolicySchema.shape.schedule.parse({ ...(req.body as any), mode: 'TEMPORARY_GRANT' });
      await validateActivitySources(schedule.sourceIds, tx);
      if (schedule.userIds.length) {
        const users = await tx`SELECT id FROM users WHERE id IN ${tx(schedule.userIds)} AND role='Member' AND deleted_at IS NULL`;
        if (users.length !== new Set(schedule.userIds).size) throw new AppError(400, 'MEMBER_SCOPE_REQUIRED', '活动仅可面向普通用户');
      }
      await writeSetting('service_policy_v3', { ...policy, schedule }, tx);
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${req.actor.id},'campaign.updated',${JSON.stringify(schedule)})`;
      return { ok: true };
    });
  });
  app.get('/api/admin/access/ai-usage', async () => sql`SELECT t.id,t.owner_id,u.name,t.created_at,t.data->>'status' AS status,t.data->'usage' AS usage,t.data->>'service' AS service FROM ai_tasks t JOIN users u ON u.id=t.owner_id WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC LIMIT 200`);
  app.get('/api/admin/access/audit', async () => sql`SELECT a.id,a.owner_id,u.name,a.action,a.target_id,a.created_at FROM audit_events a LEFT JOIN users u ON u.id=a.owner_id WHERE a.action LIKE 'access.%' OR a.action LIKE 'trial.%' OR a.action LIKE 'campaign.%' OR a.action LIKE 'service.%' OR a.action LIKE 'ai.quota%' ORDER BY a.created_at DESC LIMIT 200`);
  app.post('/api/admin/access/users/:id/traffic', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sample = z.object({ id: z.uuid(), meterId: z.string().min(1).max(100), totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), evidenceReference: z.string().min(1).max(500), periodStart: z.iso.datetime(), measuredAt: z.iso.datetime() }).strict().parse(req.body);
    if (Date.parse(sample.measuredAt) > Date.now() + 300000) throw new AppError(400, 'METER_TIME', '计量时间不能在未来');
    return sql.begin(async (tx) => {
      const [user] = await tx`SELECT role FROM users WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
      if (!user || user.role !== 'Member') throw new AppError(403, 'MEMBER_SCOPE_REQUIRED', '只能登记普通用户的真实计量数据');
      const [existing] = await tx`SELECT owner_id,data FROM traffic_usage_samples WHERE id=${sample.id}`;
      if (existing) {
        if (existing.owner_id !== id || existing.data.totalBytes !== sample.totalBytes || existing.data.meterId !== sample.meterId || existing.data.periodStart !== sample.periodStart) throw new AppError(409, 'METER_CONFLICT', '计量记录不能跨用户或重复改写');
        return { ok: true, duplicate: true };
      }
      const [latest] = await tx`SELECT data FROM traffic_usage_samples WHERE owner_id=${id} AND data->>'type'='METER_TOTAL' AND data->>'meterId'=${sample.meterId} AND data->>'periodStart'=${sample.periodStart} AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`;
      if (latest && (latest.data.totalBytes > sample.totalBytes || Date.parse(latest.data.measuredAt) > Date.parse(sample.measuredAt))) throw new AppError(409, 'METER_NOT_MONOTONIC', '累计用量不能倒退；新的计费周期应另设周期开始时间');
      await tx`INSERT INTO traffic_usage_samples(id,owner_id,data) VALUES(${sample.id},${id},${tx.json({ ...sample, type: 'METER_TOTAL', source: 'ADMIN_REPORTED' })})`;
      await tx`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${req.actor.id},'access.traffic_recorded',${JSON.stringify({ userId: id, ...sample })})`;
      return { ok: true };
    });
  });
}

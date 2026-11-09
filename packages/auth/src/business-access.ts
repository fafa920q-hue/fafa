import { z } from 'zod';
import { sql } from '../../db/src';
import { readServicePolicy } from './service-policy';

export const capabilityNames = ['node', 'server', 'codex'] as const;
export const timeZone = z.string().refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, '时区必须为有效 IANA 名称');
const ids = z.array(z.uuid()).max(500);
export const servicesSchema = z.object({ node: z.boolean(), server: z.boolean(), codex: z.boolean() });
export const memberPolicySchema = z.object({
  catalogEnabled: z.boolean().default(true),
  deny: z.array(z.enum(['node', 'server', 'codex', 'subscription'])).default([]),
  allowedSourceIds: ids.nullable().default(null),
  deniedSourceIds: ids.default([]),
  groups: z.array(z.string().max(80)).max(100).nullable().default(null),
  allowedServerIds: ids.nullable().default(null),
  deniedServerIds: ids.default([]),
  subscriptionUntil: z.iso.datetime().nullable().default(null),
  aiUntil: z.iso.datetime().nullable().default(null),
  aiServiceEnabled: z.boolean().default(true),
  nodeCeiling: z.number().int().min(0).max(5000).nullable().default(null),
  trafficPeriodStart: z.iso.datetime().default('1970-01-01T00:00:00Z'),
});
export const trialPolicySchema = z.object({
  enabled: z.boolean(),
  windowStart: z.iso.datetime(), windowEnd: z.iso.datetime(),
  timeZone,
  durationHours: z.number().min(0.25).max(8760),
  registrationMethod: z.enum(['all', 'email', 'google']).default('all'),
  emailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).max(100).default([]),
  services: servicesSchema,
  sourceIds: ids,
  nodeLimit: z.number().int().min(0).max(5000),
  trafficLimitBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  aiDailyLimit: z.number().int().min(0).max(1000),
  concurrency: z.number().int().min(1).max(10),
}).refine((v) => Date.parse(v.windowEnd) > Date.parse(v.windowStart), '结束时间必须晚于开始时间');
export const defaultTrialPolicy: z.infer<typeof trialPolicySchema> = {
  enabled: false, windowStart: '2026-11-09T00:00:00Z', windowEnd: '2026-11-10T00:00:00Z',
  timeZone: 'Asia/Shanghai', durationHours: 24, registrationMethod: 'all', emailDomains: [],
  services: { node: true, server: false, codex: false }, sourceIds: [], nodeLimit: 20,
  trafficLimitBytes: null, aiDailyLimit: 20, concurrency: 2,
};
export async function readSetting(key: string, db: any = sql) {
  const [row] = await db`SELECT value FROM settings WHERE key=${key}`;
  return row?.value;
}
export async function writeSetting(key: string, value: any, db: any = sql) {
  await db`INSERT INTO settings(key,value) VALUES(${key},${db.json(value)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
}
export function activeGrant(data: any, now = Date.now()) {
  return (!data?.startsAt || Date.parse(data.startsAt) <= now) &&
    [data?.expiresAt, data?.endsAt].every((end) => !end || Date.parse(end) > now);
}
export async function issueTrial(userId: string, db: any = sql): Promise<any | undefined> {
  const saved = await readSetting('registration_trial_v3', db);
  if (!saved) return undefined; // Preserve the previous policy until explicitly configured.
  const policy = trialPolicySchema.parse(saved);
  if (!policy.enabled) return { applied: false, reason: 'POLICY_DISABLED' };
  const [u] = await db`SELECT * FROM users WHERE id=${userId} FOR UPDATE`;
  if (!u || u.role !== 'Member' || u.disabled || u.deleted_at) return { applied: false, reason: 'ROLE_NOT_ELIGIBLE' };
  const created = new Date(u.created_at).getTime(), end = created + policy.durationHours * 3600000;
  if (created < Date.parse(policy.windowStart) || created >= Date.parse(policy.windowEnd)) return { applied: false, reason: 'OUTSIDE_WINDOW' };
  if (end <= Date.now()) return { applied: false, reason: 'TRIAL_EXPIRED' };
  const [method] = await db`SELECT EXISTS(SELECT 1 FROM member_credentials WHERE user_id=${userId}) AS email,EXISTS(SELECT 1 FROM google_identities WHERE user_id=${userId}) AS google`;
  if ((policy.registrationMethod !== 'all' && !method?.[policy.registrationMethod]) ||
    (policy.emailDomains.length && !policy.emailDomains.includes(u.email.toLowerCase().split('@').at(-1))))
    return { applied: false, reason: 'AUDIENCE_NOT_ELIGIBLE' };
  const entitlement = { ...policy, startsAt: new Date(created).toISOString(), endsAt: new Date(end).toISOString(), grantedAt: new Date().toISOString() };
  const inserted = await db`INSERT INTO settings(key,value) VALUES(${'trial_entitlement_' + userId},${db.json(entitlement)}) ON CONFLICT(key) DO NOTHING RETURNING id`;
  if (!inserted.length) return { applied: false, reason: 'ALREADY_PROCESSED' };
  await db`INSERT INTO audit_events(owner_id,action,target_id) VALUES(${userId},'trial.issued',${JSON.stringify({ userId, endsAt: entitlement.endsAt, sourceIds: policy.sourceIds })})`;
  return { applied: true, expiresAt: entitlement.endsAt, nodeStatus: policy.sourceIds.length ? 'GRANTED' : 'PENDING' };
}
export async function trafficUsage(userId: string, periodStart: string, db: any = sql) {
  const rows = await db`SELECT DISTINCT ON(data->>'meterId') data FROM traffic_usage_samples WHERE owner_id=${userId} AND revoked_at IS NULL AND data->>'type'='METER_TOTAL' AND data->>'periodStart'=${periodStart} ORDER BY data->>'meterId',created_at DESC,id DESC`;
  if (!rows.length) return { bytes: null, status: 'UNCONFIGURED' };
  const bytes = rows.reduce((sum: number, r: any) => sum + Number(r.data.totalBytes), 0);
  return { bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null, status: 'ADMIN_REPORTED' };
}
export async function resolveAccess<T extends Record<string, any>>(input: T, db: any = sql): Promise<T & { _access: any }> {
  if (input?._access) return input as any;
  const user: any = { ...input };
  const policy = memberPolicySchema.parse((await readSetting('business_access_' + user.id, db)) || {});
  const trial = await readSetting('trial_entitlement_' + user.id, db);
  const service = await readServicePolicy(db);
  const quota = (await readSetting('ai_quota_' + user.id, db)) || { dailyLimit: 20, concurrency: 2 };
  const now = Date.now(), admin = ['Owner', 'Admin'].includes(user.role), blocked = !!user.disabled || !!user.deleted_at;
  const campaign: any = service.schedule;
  const audience = campaign.allMembers !== false || campaign.userIds?.includes(user.id);
  const globalActive = campaign.mode === 'TEMPORARY_GRANT' && campaign.enabled && !campaign.paused && audience && activeGrant({ startsAt: campaign.startsAt, endsAt: campaign.endsAt }, now);
  const overlays: any[] = [];
  if (user.role === 'Member' && !blocked) {
    if (trial && activeGrant(trial, now)) overlays.push({ ...trial, kind: 'TRIAL' });
    if (globalActive) overlays.push({ ...campaign, kind: 'GLOBAL' });
  }
  const base: any = {}, effective: any = {};
  for (const [kind, prefix] of [['node', 'node_access'], ['server', 'server_connect'], ['codex', 'codex_tasks']] as const) {
    base[kind] = !blocked && (admin || (user[prefix + '_enabled'] === true && (!user[prefix + '_until'] || new Date(user[prefix + '_until']).getTime() > now)));
    effective[kind] = !blocked && (admin || (!policy.deny.includes(kind) && (base[kind] || overlays.some((v) => v.services?.[kind]))));
  }
  if (!admin && policy.aiUntil && Date.parse(policy.aiUntil) <= now) effective.codex = false;
  const nodeOverlays = overlays.filter((v) => v.services?.node);
  let nodeLimit = Math.max(base.node ? Number(user.node_limit || 0) : 0, ...nodeOverlays.map((v) => Number(v.nodeLimit || 0)));
  if (policy.nodeCeiling !== null) nodeLimit = Math.min(nodeLimit, policy.nodeCeiling);
  if (!effective.node) nodeLimit = 0;
  const usage = await trafficUsage(user.id, policy.trafficPeriodStart, db);
  const limits = [base.node && user.traffic_limit_bytes != null ? Number(user.traffic_limit_bytes) : null, ...nodeOverlays.map((v) => v.trafficLimitBytes)].filter((v) => v !== null && v !== undefined);
  const trafficLimit = limits.length ? Math.min(...limits) : null;
  if (!admin && trafficLimit !== null && (usage.bytes === null || usage.bytes >= trafficLimit)) effective.node = false;
  const aiOverlays = overlays.filter((v) => v.services?.codex);
  const aiQuota = {
    dailyLimit: base.codex ? Number(quota.dailyLimit) : 0,
    concurrency: base.codex ? Number(quota.concurrency) : 1,
  };
  for (const overlay of aiOverlays) {
    aiQuota.dailyLimit = Math.max(aiQuota.dailyLimit, overlay.aiDailyLimit ?? 20);
    aiQuota.concurrency = Math.max(aiQuota.concurrency, overlay.concurrency ?? 2);
  }
  // Explicit per-user quota is a ceiling, including a zero-call administrative suspension.
  if (await readSetting('ai_quota_' + user.id, db)) {
    aiQuota.dailyLimit = Math.min(aiQuota.dailyLimit, Number(quota.dailyLimit));
    aiQuota.concurrency = Math.min(aiQuota.concurrency, Number(quota.concurrency));
  }
  user.node_limit = admin ? input.node_limit : nodeLimit;
  user.subscription_enabled = input.subscription_enabled === true && (admin || (!policy.deny.includes('subscription') && (!policy.subscriptionUntil || Date.parse(policy.subscriptionUntil) > now)));
  user._access = { base, capabilities: effective, policy, overlaySources: [...new Set(nodeOverlays.flatMap((v) => v.sourceIds || []))], overlays: overlays.map((v) => ({ kind: v.kind, endsAt: v.endsAt })),
    aiQuota, aiServiceAllowed: policy.aiServiceEnabled && effective.codex && (overlays.length === 0 || base.codex || aiOverlays.length > 0),
    traffic: { ...usage, limitBytes: trafficLimit, enforcement: trafficLimit === null ? 'UNLIMITED' : usage.bytes === null ? 'METER_REQUIRED_ACCESS_BLOCKED' : 'PANEL_ACCESS_ENFORCED', dataPlaneEnforcement: 'EXTERNAL_GATEWAY_REQUIRED' } };
  return user;
}
export function sourceAllowed(user: any, sourceId: string, group = '') {
  if (['Owner', 'Admin'].includes(user.role)) return true;
  const policy = user._access?.policy;
  return !policy || (!policy.deniedSourceIds.includes(sourceId) && (policy.allowedSourceIds === null || policy.allowedSourceIds.includes(sourceId)) && (policy.groups === null || policy.groups.includes(group)));
}
export function serverAllowed(user: any, serverId: string) {
  if (['Owner', 'Admin'].includes(user.role)) return true;
  const policy = user._access?.policy;
  return !policy || (!policy.deniedServerIds.includes(serverId) && (policy.allowedServerIds === null || policy.allowedServerIds.includes(serverId)));
}
export function teamServiceAllowed(user: any, policy: any) {
  return !!user && !user.disabled && !user.deleted_at && user._access?.aiServiceAllowed === true && policy.ai.enabled &&
    (!policy.ai.until || Date.parse(policy.ai.until) > Date.now()) &&
    (['Owner', 'Admin'].includes(user.role) || policy.ai.allMembers !== false || policy.ai.userIds.includes(user.id));
}

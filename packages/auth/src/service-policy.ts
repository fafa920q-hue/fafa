import { z } from 'zod';
import { sql } from '../../db/src';
import { AppError } from '../../shared/src';

export const servicePolicySchema = z.object({
  schedule: z
    .object({
      enabled: z.boolean(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      mode: z.enum(['WINDOW_ONLY', 'TEMPORARY_GRANT']).default('WINDOW_ONLY'),
      timeZone: z.string().default('Asia/Shanghai').refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, '无效时区'),
      paused: z.boolean().default(false),
      allMembers: z.boolean().default(true),
      userIds: z.array(z.uuid()).max(500).default([]),
      services: z.object({ node: z.boolean(), server: z.boolean(), codex: z.boolean() }).default({ node: true, server: false, codex: false }),
      sourceIds: z.array(z.uuid()).max(500).default([]),
      nodeLimit: z.number().int().min(0).max(5000).default(20),
      trafficLimitBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
      aiDailyLimit: z.number().int().min(0).max(1000).default(20),
      concurrency: z.number().int().min(1).max(10).default(2),
    })
    .refine(
      (v) => Date.parse(v.endsAt) > Date.parse(v.startsAt),
      '结束时间必须晚于开始时间',
    ),
  ai: z.object({
    enabled: z.boolean(),
    accountId: z.uuid().nullable(),
    dailyLimit: z.number().int().min(0).max(1000),
    concurrency: z.number().int().min(1).max(10),
    maxOutputTokens: z.number().int().min(1).max(16000),
    allMembers: z.boolean().default(true),
    userIds: z.array(z.uuid()).max(500).default([]),
    until: z.iso.datetime().nullable().default(null),
  }),
});
export type ServicePolicy = z.infer<typeof servicePolicySchema>;
export const defaultServicePolicy: ServicePolicy = {
  schedule: {
    enabled: false,
    startsAt: '2026-11-08T00:00:00Z',
    endsAt: '2026-11-09T00:00:00Z',
    mode: 'WINDOW_ONLY', timeZone: 'Asia/Shanghai', paused: false, allMembers: true, userIds: [],
    services: { node: true, server: false, codex: false }, sourceIds: [], nodeLimit: 20,
    trafficLimitBytes: null, aiDailyLimit: 20, concurrency: 2,
  },
  ai: {
    enabled: false,
    accountId: null,
    dailyLimit: 20,
    concurrency: 2,
    maxOutputTokens: 2000,
    allMembers: true, userIds: [], until: null,
  },
};
export async function readServicePolicy(db: any = sql): Promise<ServicePolicy> {
  const [row] =
    await db`SELECT value FROM settings WHERE key='service_policy_v3'`;
  // A malformed configured policy fails closed rather than reverting to open service.
  return row ? servicePolicySchema.parse(row.value) : defaultServicePolicy;
}
export function serviceOpen(
  policy: z.input<typeof servicePolicySchema>,
  user: any,
  now = Date.now(),
) {
  if (user.disabled || user.deleted_at) return false;
  if (user.role === 'Owner' || user.role === 'Admin') return true;
  if (policy.schedule.mode === 'TEMPORARY_GRANT' || (policy.schedule.allMembers === false && !policy.schedule.userIds?.includes(user.id))) return true;
  return (
    !policy.schedule.enabled ||
    (now >= Date.parse(policy.schedule.startsAt) &&
      now < Date.parse(policy.schedule.endsAt))
  );
}
export async function assertServiceOpen(user: any, db: any = sql) {
  if (!serviceOpen(await readServicePolicy(db), user))
    throw new AppError(
      403,
      'SERVICE_CLOSED',
      '服务尚未开放或开放时间已结束，请联系管理员',
    );
}
export const aiQuotaSchema = z.object({
  dailyLimit: z.number().int().min(0).max(1000),
  concurrency: z.number().int().min(1).max(10),
});
export async function readAiQuota(userId: string, db: any = sql) {
  const [user] = await db`SELECT * FROM users WHERE id=${userId}`;
  if (!user) return { dailyLimit: 0, concurrency: 1 };
  const { resolveAccess } = await import('./business-access');
  return (await resolveAccess(user, db))._access.aiQuota;
}

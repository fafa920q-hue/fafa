import { z } from 'zod';
import { sql } from '../../db/src';
import { AppError } from '../../shared/src';

export const servicePolicySchema = z.object({
  schedule: z
    .object({
      enabled: z.boolean(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
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
  }),
});
export type ServicePolicy = z.infer<typeof servicePolicySchema>;
export const defaultServicePolicy: ServicePolicy = {
  schedule: {
    enabled: false,
    startsAt: '2026-11-08T00:00:00Z',
    endsAt: '2026-11-09T00:00:00Z',
  },
  ai: {
    enabled: false,
    accountId: null,
    dailyLimit: 20,
    concurrency: 2,
    maxOutputTokens: 2000,
  },
};
export async function readServicePolicy(db: any = sql): Promise<ServicePolicy> {
  const [row] =
    await db`SELECT value FROM settings WHERE key='service_policy_v3'`;
  // A malformed configured policy fails closed rather than reverting to open service.
  return row ? servicePolicySchema.parse(row.value) : defaultServicePolicy;
}
export function serviceOpen(
  policy: ServicePolicy,
  user: any,
  now = Date.now(),
) {
  if (user.disabled || user.deleted_at) return false;
  if (user.role === 'Owner' || user.role === 'Admin') return true;
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
  const [row] =
    await db`SELECT value FROM settings WHERE key=${'ai_quota_' + userId}`;
  return row
    ? aiQuotaSchema.parse(row.value)
    : { dailyLimit: 20, concurrency: 2 };
}

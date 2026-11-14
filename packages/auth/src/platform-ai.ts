import { z } from 'zod';
import { platformModels } from '../../shared/src/platform-ai';

export const models = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,149}$/);
export const modelList = z
  .array(models)
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length);
export const money = z.number().int().min(1).max(1_000_000_000_000);
export const limits = z
  .object({ daily: money, monthly: money })
  .refine((v) => v.daily <= v.monthly);
export const userQuota = z.object({
  limits,
  task: money,
  dailyTokens: z.number().int().min(1000).max(100_000_000).default(1_000_000),
  requestsPerMinute: z.number().int().min(1).max(60).default(6),
  models: modelList,
  concurrency: z.number().int().min(1).max(20),
  enabled: z.boolean(),
});
export const policySchema = z.object({
  enabled: z.boolean(),
  globalMonthly: money,
  globalDaily: money.default(10_000_000),
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return !/^[+-]/.test(value);
      } catch {
        return false;
      }
    })
    .default('UTC'),
  allowTextAttachments: z.boolean().default(false),
  project: limits,
  defaultUser: userQuota,
  maxOutput: z.number().int().min(16).max(16000),
  routing: z.enum(['BALANCED', 'HEALTH', 'ACCOUNT', 'PROJECT']),
  target: z.string().max(100).default(''),
});
export const defaultPolicy = policySchema.parse({
  enabled: false,
  globalMonthly: 10_000_000,
  project: { daily: 2_000_000, monthly: 10_000_000 },
  defaultUser: {
    limits: { daily: 1_000_000, monthly: 5_000_000 },
    task: 1_000_000,
    models: Object.keys(platformModels),
    concurrency: 1,
    enabled: true,
  },
  maxOutput: 2000,
  routing: 'BALANCED',
});
export async function configuration(db: any, userId?: string) {
  const [setting] =
    await db`select value from settings where key='platform_ai_v1'`;
  const policy = setting ? policySchema.parse(setting.value) : defaultPolicy;
  const [override] = userId
    ? await db`select value from settings where key=${'platform_ai_quota:' + userId}`
    : [];
  return {
    policy,
    quota: override ? userQuota.parse(override.value) : policy.defaultUser,
  };
}
// 项目暂停判定：platform_ai_pause:<project_id> 的值是 Worker 写入的
// to_jsonb(now() + interval)，即 JSON 字符串形式的时间戳。
// 2026-11-14 回归：旧实现在 choices() 的 SQL 里用
// `(value #>> '{}')::timestamptz > now()` 做 NOT EXISTS 子查询，
// Postgres 在 Hash Anti Join 等计划下会把这个 cast 当作 settings
// 全表的 Seq Scan 过滤条件先求值，表里 auto_grant_enabled、
// maintenance 等 JSON 布尔值 false 一转 timestamptz 就抛
// invalid input syntax，GET /api/ai/platform 直接 500。
// AND 子句的先后顺序不能保证求值顺序，所以不能只调换条件。
// 改为按精确 key 取回原始文本、在 JS 里解析：只有命中该项目的那一
// 行会被解析，其他行的值永远不会进入时间戳转换。
export function isPausedValue(
  raw: unknown,
  nowMs: number = Date.now(),
): boolean {
  if (typeof raw !== 'string') return false;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > nowMs;
}

export async function projectPaused(
  db: any,
  projectId: string,
): Promise<boolean> {
  const [row] =
    await db`select value #>> '{}' as until from settings where key=${'platform_ai_pause:' + projectId}`;
  return isPausedValue(row?.until);
}

export function allowed(actor: any) {
  return (
    actor &&
    !actor.disabled &&
    !actor.deleted_at &&
    actor.role !== 'Viewer' &&
    actor._access?.aiServiceAllowed === true
  );
}

export async function budget(
  db: any,
  filter: { user?: string; account?: string; project?: string } = {},
  timeZone = 'UTC',
) {
  const [r] = await db`select
    coalesce(sum(coalesce(charged_micros,reserved_micros)) filter (where created_at >= date_trunc('day', now(), ${timeZone})),0) as daily,
    coalesce(sum(coalesce(charged_micros,reserved_micros)),0) as monthly,
    coalesce(sum(charged_micros),0) as charged,
    coalesce(sum(coalesce(input_tokens + output_tokens,case when charged_micros is null then coalesce(reserved_tokens,278144) else 0 end))
      filter (where created_at >= date_trunc('day',now(),${timeZone})),0) as day_tokens,
    coalesce(sum(input_tokens),0) as input, coalesce(sum(output_tokens),0) as output,
    coalesce(sum(reserved_micros) filter (where charged_micros is null),0) as unsettled
    from ai_platform_usage where created_at >= date_trunc('month', now(), ${timeZone})
      and (${filter.user ?? null}::uuid is null or user_id=${filter.user ?? null})
      and (${filter.account ?? null}::uuid is null or account_id=${filter.account ?? null})
      and (${filter.project ?? null}::text is null or project_id=${filter.project ?? null})`;
  return {
    daily: Number(r.daily),
    dayTokens: Number(r.day_tokens),
    monthly: Number(r.monthly),
    charged: Number(r.charged),
    input: Number(r.input),
    output: Number(r.output),
    unsettled: Number(r.unsettled),
  };
}
export const fits = (
  spend: Awaited<ReturnType<typeof budget>>,
  limit: z.infer<typeof limits>,
  reserve: number,
) =>
  spend.daily + reserve <= limit.daily &&
  spend.monthly + reserve <= limit.monthly;

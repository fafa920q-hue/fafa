import {
  models,
  modelList,
  limits,
  userQuota,
  policySchema,
  configuration,
  allowed,
  budget,
  fits,
} from '../../../packages/auth/src/platform-ai';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import {
  AppError,
  notFound,
  anthropicApiEnabled,
} from '../../../packages/shared/src';
import { seal } from '../../../packages/shared/src/crypto';
import {
  platformAiEnabled,
  platformModels,
  platformReserve,
} from '../../../packages/shared/src/platform-ai';
import { resolveAccess } from '../../../packages/auth/src/business-access';
import {
  assertServiceOpen,
  readAiQuota,
} from '../../../packages/auth/src/service-policy';

const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  note: z.string().max(500),
  projectId: z
    .string()
    .regex(/^proj_[a-zA-Z0-9_-]+$/)
    .max(100),
  serviceAccountId: z
    .string()
    .regex(/^svc_acct_[a-zA-Z0-9_-]+$/)
    .max(100),
  limits,
  models: modelList,
  enabled: z.boolean(),
  concurrency: z.number().int().min(1).max(20),
});
const apiKey = z
  .string()
  .regex(/^sk-(?!admin-)[A-Za-z0-9_-]{16,}$/)
  .max(512);
function owner(actor: any) {
  if (!platformAiEnabled() || actor.role !== 'Owner') throw notFound();
}
const accountColumns = sql`id, project_id, service_account_id, name, note, models, enabled, health,
  daily_micros, monthly_micros, concurrency, checked_at, last_error`;
async function choices(db: any, policy: z.infer<typeof policySchema>) {
  return db`select a.id, a.project_id, a.models, a.daily_micros, a.monthly_micros, a.revision, a.concurrency,
      (select count(*)::int from ai_tasks t where t.platform_account_id=a.id and t.data->>'status' in ('QUEUED','RUNNING')) as active
    from ai_platform_accounts a
    where enabled and health='READY' and secret is not null
      and not exists (select 1 from settings where key='platform_ai_pause:' || a.project_id
        and (value #>> '{}')::timestamptz > now())
      and (${policy.routing} <> 'ACCOUNT' or id::text=${policy.target})
      and (${policy.routing} <> 'PROJECT' or project_id=${policy.target})
    order by case when ${policy.routing}='HEALTH' then checked_at end desc nulls last, active, id`;
}
export async function submitPlatformTask(
  actor: any,
  input: { model: z.infer<typeof models>; prompt: string; workspace: string },
) {
  const task = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77708)`;
    const [raw] = await tx`select * from users where id=${actor.id} for share`;
    const current = raw ? await resolveAccess(raw, tx) : null;
    if (!current || !allowed(current))
      throw new AppError(403, 'CAPABILITY_REQUIRED', '平台 AI 服务未授权');
    await assertServiceOpen(current, tx);
    const { policy, quota } = await configuration(tx, actor.id);
    if (!policy.enabled || process.env.DEMO_MODE === 'true')
      throw new AppError(409, 'AI_SERVICE_CLOSED', '平台 AI 服务未开放');
    if (!quota.enabled || !quota.models.includes(input.model))
      throw new AppError(403, 'CAPABILITY_REQUIRED', '模型或额度未授权');
    const reserved = platformReserve(input.model, policy.maxOutput);
    const [count] =
      await tx`select count(*) filter (where data->>'status' in ('QUEUED','RUNNING'))::int active,
      count(*) filter (where created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')::int daily
      from ai_tasks where owner_id=${actor.id}`;
    if (
      count.active >=
        Math.min(quota.concurrency, current._access.aiQuota.concurrency) ||
      count.daily >= current._access.aiQuota.dailyLimit ||
      reserved > quota.task ||
      !fits(await budget(tx, { user: actor.id }), quota.limits, reserved) ||
      (await budget(tx)).monthly + reserved > policy.globalMonthly
    )
      throw new AppError(429, 'AI_BUDGET', '平台或个人预算、并发已达限制');
    for (const a of await choices(tx, policy)) {
      if (
        !a.models.includes(input.model) ||
        a.active >= a.concurrency ||
        !fits(
          await budget(tx, { project: a.project_id }),
          policy.project,
          reserved,
        ) ||
        !fits(
          await budget(tx, { account: a.id }),
          { daily: Number(a.daily_micros), monthly: Number(a.monthly_micros) },
          reserved,
        )
      )
        continue;
      const data = {
        ...input,
        status: 'QUEUED',
        output: '',
        provider: 'OPENAI_API',
        platform: true,
        maxOutputTokens: policy.maxOutput,
      };
      const [r] =
        await tx`insert into ai_tasks(owner_id,platform_account_id,data) values(${actor.id},${a.id},${tx.json(data)}) returning id`;
      await tx`insert into ai_platform_usage(task_id,user_id,account_id,project_id,model,account_revision,reserved_micros)
        values(${r.id},${actor.id},${a.id},${a.project_id},${input.model},${a.revision},${reserved})`;
      return r;
    }
    throw new AppError(
      409,
      'AI_SERVICE_CLOSED',
      '没有符合模型、健康状态和额度要求的服务账户',
    );
  });
  await audit(actor.id, 'ai.platform_task_created', task.id);
  return task;
}

export async function registerPlatformAi(app: FastifyInstance) {
  app.get('/api/ai/platform', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!platformAiEnabled()) return { mode: false };
    const { policy, quota } = await configuration(sql, req.actor.id);
    const available = new Set<keyof typeof platformModels>();
    const spend = await budget(sql, { user: req.actor.id });
    if (
      allowed(req.actor) &&
      policy.enabled &&
      quota.enabled &&
      process.env.DEMO_MODE !== 'true'
    ) {
      const total = await budget(sql);
      for (const a of await choices(sql, policy)) {
        for (const model of quota.models) {
          const reserve = platformReserve(model, policy.maxOutput);
          if (
            a.models.includes(model) &&
            reserve <= quota.task &&
            fits(spend, quota.limits, reserve) &&
            total.monthly + reserve <= policy.globalMonthly &&
            fits(
              await budget(sql, { project: a.project_id }),
              policy.project,
              reserve,
            ) &&
            fits(
              await budget(sql, { account: a.id }),
              {
                daily: Number(a.daily_micros),
                monthly: Number(a.monthly_micros),
              },
              reserve,
            )
          )
            available.add(model);
        }
      }
    }
    return {
      mode: true,
      claude: anthropicApiEnabled(),
      models: [...available],
      quota: {
        daily: Math.max(0, quota.limits.daily - spend.daily),
        monthly: Math.max(0, quota.limits.monthly - spend.monthly),
        concurrency: Math.min(
          quota.concurrency,
          (await readAiQuota(req.actor.id)).concurrency,
        ),
        charged: spend.charged,
        input: spend.input,
        output: spend.output,
      },
    };
  });
  app.post('/api/ai/platform/tasks', async (req) => {
    if (!platformAiEnabled()) throw notFound();
    return submitPlatformTask(
      req.actor,
      z
        .strictObject({
          model: models,
          prompt: z.string().trim().min(1).max(16000),
          workspace: z.string().max(300).default(''),
        })
        .parse(req.body),
    );
  });
  app.get('/api/admin/ai-platform', async (req, reply) => {
    owner(req.actor);
    reply.header('Cache-Control', 'no-store');
    const { policy } = await configuration(sql);
    const rows =
      await sql`select ${accountColumns} from ai_platform_accounts order by name,id`;
    return {
      models: Object.keys(platformModels),
      policy,
      usage: await budget(sql),
      accounts: await Promise.all(
        rows.map(async (row) => ({
          ...row,
          usage: await budget(sql, { account: row.id }),
        })),
      ),
    };
  });
  app.patch('/api/admin/ai-platform/policy', async (req) => {
    owner(req.actor);
    const d = policySchema.parse(req.body);
    if (
      (d.routing === 'ACCOUNT' && !z.uuid().safeParse(d.target).success) ||
      (d.routing === 'PROJECT' && !/^proj_[\w-]+$/.test(d.target))
    )
      throw new AppError(400, 'AI_ROUTING_TARGET', '请填写有效的路由目标');
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      await tx`insert into settings(key,value) values ('platform_ai_v1',${tx.json(d)})
        on conflict (key) do update set value=excluded.value`;
    });
    await audit(req.actor.id, 'ai.platform_policy_updated');
    return { ok: true };
  });
  app.get('/api/admin/ai-platform/quota/:id', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { quota } = await configuration(sql, id);
    return quota;
  });
  app.patch('/api/admin/ai-platform/quota/:id', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const d = userQuota.parse(req.body);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      if (
        !(await tx`select id from users where id=${id} and deleted_at is null`)
          .length
      )
        throw notFound();
      await tx`insert into settings(key,value) values (${'platform_ai_quota:' + id},${tx.json(d)})
        on conflict (key) do update set value=excluded.value`;
    });
    await audit(req.actor.id, 'ai.platform_quota_updated', id);
    return { ok: true };
  });
  app.post('/api/admin/ai-platform/accounts', async (req) => {
    owner(req.actor);
    const d = accountSchema
      .extend({ apiKey, confirmServiceAccount: z.literal(true) })
      .parse(req.body);
    const [row] = await sql`insert into ai_platform_accounts
      (project_id,service_account_id,name,note,models,secret,daily_micros,monthly_micros,concurrency)
      values (${d.projectId},${d.serviceAccountId},${d.name},${d.note},${d.models},${sql.json(seal(d.apiKey))},
        ${d.limits.daily},${d.limits.monthly},${d.concurrency})
      on conflict (project_id,service_account_id) do nothing returning id`;
    if (!row)
      throw new AppError(409, 'AI_ACCOUNT_EXISTS', '此项目服务账户已存在');
    await audit(req.actor.id, 'ai.platform_account_created', row.id);
    return row;
  });
  app.patch('/api/admin/ai-platform/accounts/:id', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const d = accountSchema
      .omit({ projectId: true, serviceAccountId: true })
      .parse(req.body);
    const [r] = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      return tx`update ai_platform_accounts set name=${d.name},note=${d.note},
        enabled=${d.enabled} and health='READY' and secret is not null and models=${d.models},
        health=case when models<>${d.models} and secret is not null then 'UNCHECKED' else health end,
        revision=revision+1, models=${d.models}, daily_micros=${d.limits.daily},
        monthly_micros=${d.limits.monthly}, concurrency=${d.concurrency} where id=${id} returning id,enabled`;
    });
    if (!r) throw notFound();
    await audit(req.actor.id, 'ai.platform_account_updated', id);
    return r;
  });
  app.post('/api/admin/ai-platform/accounts/:id/credential', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const d = z
      .discriminatedUnion('action', [
        z.object({
          action: z.literal('rotate'),
          apiKey,
          confirmServiceAccount: z.literal(true),
        }),
        z.object({ action: z.literal('revoke') }),
      ])
      .parse(req.body);
    const secret = d.action === 'rotate' ? sql.json(seal(d.apiKey)) : null;
    const [r] =
      await sql`update ai_platform_accounts set secret=${secret}, revision=revision+1,
      enabled=false, health=${secret ? 'UNCHECKED' : 'REVOKED'}, checked_at=null, last_error=null
      where id=${id} returning id`;
    if (!r) throw notFound();
    await audit(req.actor.id, 'ai.platform_credential_' + d.action, id);
    return { ok: true };
  });
  app.post('/api/admin/ai-platform/accounts/:id/test', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (process.env.DEMO_MODE === 'true')
      throw new AppError(409, 'AI_UNCONFIGURED', '演示模式不连接外部服务');
    const [row] =
      await sql`update ai_platform_accounts set health='CHECK_PENDING', enabled=false, revision=revision+1
      where id=${id} and secret is not null returning id`;
    if (!row) throw notFound();
    await audit(req.actor.id, 'ai.platform_connection_queued', id);
    return { health: 'CHECK_PENDING' };
  });
}

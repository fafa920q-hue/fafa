import {
  audience,
  modelForUser,
  platformModelConfig,
} from '../../../packages/auth/src/platform-models';
import { platformAccountsEnabled } from '../../../packages/auth/src/platform-gpt';
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
  platformReserve,
} from '../../../packages/shared/src/platform-ai';
import { resolveAccess } from '../../../packages/auth/src/business-access';
import {
  assertServiceOpen,
  readAiQuota,
} from '../../../packages/auth/src/service-policy';

// 服务账户编号：OpenAI Admin API（List 与 Create 服务账户）返回的 id 均
// 以 user- 开头（例如 user-TEST123），文档示例 svc_acct_abc
// 只是占位写法，真实接口并不返回 svc_acct_。两种前缀都接受；仍拒绝
// 其他前缀。凭据与标识字段先去首尾空白再做格式校验：从 OpenAI 控制台
// 粘贴时常带换行/空格，未 trim 会直接报 400。trim 后仍拒绝 sk-admin-、
// 过短、错误前缀等非法格式。导出以便单元测试直接引用。
export const accountSchema = z.object({
  priority: z.number().int().min(1).max(1000).default(100),
  allowedUsers: audience.default(null),
  name: z.string().trim().min(1).max(100),
  note: z.string().max(500),
  projectId: z
    .string()
    .trim()
    .regex(/^proj_[a-zA-Z0-9_-]+$/)
    .max(100),
  serviceAccountId: z
    .string()
    .trim()
    .regex(/^(?:svc_acct_|user-)[A-Za-z0-9_-]+$/)
    .max(100),
  limits,
  models: modelList,
  enabled: z.boolean(),
  concurrency: z.number().int().min(1).max(20),
});
export const apiKey = z
  .string()
  .trim()
  .regex(/^sk-(?!admin-)[A-Za-z0-9_-]{16,}$/)
  .max(512);
function owner(actor: any) {
  if (!platformAccountsEnabled() || actor.role !== 'Owner') throw notFound();
}
const accountColumns = sql`id, project_id, service_account_id, name, note, models, enabled, health,
  daily_micros, monthly_micros, concurrency, checked_at, last_error, priority, allowed_users, (secret is not null) as has_key`;
// 管理列表回傳的帳號列：把資料庫的 daily_micros/monthly_micros 另外
// 對映成前端用的 limits {daily, monthly}。2026-11-14 回歸：之前 GET
// /api/admin/ai-platform 直接回傳原始列、沒有 limits，導致前端
// toggleEnabled 以 limits: {} 呼叫 PATCH，Zod 報
// limits.daily/monthly expected number, received undefined，啟用永遠
// 失敗。匯出以便單元測試直接驗證對映。
export function mapAdminAccount(row: any) {
  return {
    ...row,
    limits: {
      daily: Number(row.daily_micros),
      monthly: Number(row.monthly_micros),
    },
  };
}
async function choices(
  db: any,
  policy: z.infer<typeof policySchema>,
  userId: string,
) {
  return db`select a.id, a.project_id, a.models, a.daily_micros, a.monthly_micros, a.revision, a.concurrency,
      (select count(*)::int from ai_tasks t where t.platform_account_id=a.id and t.data->>'status' in ('QUEUED','PREPARING','RUNNING')) as active
    from ai_platform_accounts a
    where enabled and health='READY' and secret is not null
      and (allowed_users is null or ${userId}::uuid=any(allowed_users))
      and not exists (select 1 from settings where key='platform_ai_pause:' || a.project_id
        and (value #>> '{}')::timestamptz > now())
      and (${policy.routing} <> 'ACCOUNT' or id::text=${policy.target})
      and (${policy.routing} <> 'PROJECT' or project_id=${policy.target})
    order by case when ${policy.routing}='HEALTH' then checked_at end desc nulls last, priority, active, id`;
}
export async function submitPlatformTask(
  actor: any,
  input: { model: string; prompt: string; workspace: string },
  chat?: {
    id: string;
    requestId: string;
    retryOf?: string;
    attachment?: { name: string; text: string };
  },
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
    let prompt = input.prompt;
    let turnRoot: string | null = null;
    if (chat?.attachment) {
      if (!policy.allowTextAttachments)
        throw new AppError(
          403,
          'AI_ATTACHMENTS_DISABLED',
          '管理员尚未启用文本附件',
        );
      prompt +=
        '\n\n附件 ' + chat.attachment.name + '\n' + chat.attachment.text;
      if (prompt.length > 16000)
        throw new AppError(400, 'AI_CHAT_INPUT', '消息与附件合计超过长度限制');
    }
    if (chat) {
      const [room] =
        await tx`select id from ai_platform_chats where id=${chat.id}
        and owner_id=${actor.id} and deleted_at is null for update`;
      if (!room) throw notFound();
      const [duplicate] =
        await tx`select id from ai_tasks where chat_id=${chat.id}
        and client_request_id=${chat.requestId} and owner_id=${actor.id}`;
      if (duplicate) return duplicate;
      const [previous] =
        await tx`select id,data from ai_tasks where chat_id=${chat.id} and owner_id=${actor.id}
        and revoked_at is null order by created_at desc,id desc limit 1`;
      if (previous && ['QUEUED', 'RUNNING'].includes(previous.data.status))
        throw new AppError(409, 'AI_CHAT_ACTIVE', '请等待或停止当前回复');
      if (chat.retryOf) {
        if (previous?.id !== chat.retryOf)
          throw new AppError(409, 'AI_CHAT_RETRY', '仅能重新生成最近一次回复');
        prompt = previous.data.prompt;
        turnRoot = previous.data.turnRoot ?? previous.id;
      }
    }
    const model = await modelForUser(tx, input.model, actor.id);
    if (!model)
      throw new AppError(403, 'AI_MODEL_UNAVAILABLE', '模型未授权或已停用');
    const reserved = platformReserve(model.pricing, policy.maxOutput);
    const global = await budget(tx, {}, policy.timeZone);
    const personal = await budget(tx, { user: actor.id }, policy.timeZone);
    const reservedTokens = model.pricing.context + policy.maxOutput;

    const [count] =
      await tx`select count(*) filter (where data->>'status' in ('QUEUED','PREPARING','RUNNING'))::int active,
      count(*) filter (where created_at >= date_trunc('day', now(), ${policy.timeZone}))::int daily
          ,count(*) filter (where created_at >= now()-interval '1 minute')::int recent
      from ai_tasks where owner_id=${actor.id}`;
    if (
      global.daily + reserved > policy.globalDaily ||
      global.monthly + reserved > policy.globalMonthly
    )
      throw new AppError(429, 'AI_GLOBAL_BUDGET', '平台已达到消费上限');
    if (reserved > Number(model.task_micros))
      throw new AppError(
        429,
        'AI_MODEL_BUDGET',
        '任务超出该模型的单次费用上限',
      );
    if (
      personal.dayTokens + reservedTokens > quota.dailyTokens ||
      reserved > quota.task ||
      !fits(personal, quota.limits, reserved)
    )
      throw new AppError(429, 'AI_USER_BUDGET', '已达到个人费用或 tokens 上限');
    if (
      count.active >=
        Math.min(quota.concurrency, current._access.aiQuota.concurrency) ||
      count.daily >= current._access.aiQuota.dailyLimit ||
      count.recent >= quota.requestsPerMinute
    )
      throw new AppError(
        429,
        'AI_REQUEST_LIMIT',
        '已达到个人请求频率或并发限制',
      );
    for (const a of await choices(tx, policy, actor.id)) {
      if (
        !a.models.includes(input.model) ||
        a.active >= a.concurrency ||
        !fits(
          await budget(tx, { project: a.project_id }, policy.timeZone),
          policy.project,
          reserved,
        ) ||
        !fits(
          await budget(tx, { account: a.id }, policy.timeZone),
          { daily: Number(a.daily_micros), monthly: Number(a.monthly_micros) },
          reserved,
        )
      )
        continue;
      const data = {
        ...input,
        prompt,
        retryOf: chat?.retryOf ?? null,
        turnRoot,
        status: 'QUEUED',
        output: '',
        provider: 'OPENAI_API',
        platform: true,
        maxOutputTokens: policy.maxOutput,
      };
      const [r] =
        await tx`insert into ai_tasks(owner_id,platform_account_id,chat_id,client_request_id,data) values(${actor.id},${a.id},${chat?.id ?? null},${chat?.requestId ?? null},${tx.json(data)}) returning id`;
      await tx`insert into ai_platform_usage(task_id,user_id,account_id,project_id,model,account_revision,reserved_micros,pricing,reserved_tokens)
        values(${r.id},${actor.id},${a.id},${a.project_id},${input.model},${a.revision},${reserved},${tx.json(model.pricing)},${reservedTokens})`;
      if (chat)
        await tx`update ai_platform_chats set updated_at=now() where id=${chat.id}`;
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
    if (!platformAccountsEnabled()) return { mode: false };
    const gpt = platformAiEnabled();
    const { policy, quota } = await configuration(sql, req.actor.id);
    const available = new Map<
      string,
      { id: string; label: string; default: boolean }
    >();
    const spend = await budget(sql, { user: req.actor.id }, policy.timeZone);
    if (
      gpt &&
      allowed(req.actor) &&
      policy.enabled &&
      quota.enabled &&
      process.env.DEMO_MODE !== 'true'
    ) {
      const total = await budget(sql, {}, policy.timeZone);
      for (const a of await choices(sql, policy, req.actor.id)) {
        for (const model of quota.models) {
          const config = await modelForUser(sql, model, req.actor.id);
          if (!config) continue;
          const reserve = platformReserve(config.pricing, policy.maxOutput);
          if (
            a.models.includes(model) &&
            reserve <= Math.min(quota.task, Number(config.task_micros)) &&
            spend.dayTokens + config.pricing.context + policy.maxOutput <=
              quota.dailyTokens &&
            total.daily + reserve <= policy.globalDaily &&
            fits(spend, quota.limits, reserve) &&
            total.monthly + reserve <= policy.globalMonthly &&
            fits(
              await budget(sql, { project: a.project_id }, policy.timeZone),
              policy.project,
              reserve,
            ) &&
            fits(
              await budget(sql, { account: a.id }, policy.timeZone),
              {
                daily: Number(a.daily_micros),
                monthly: Number(a.monthly_micros),
              },
              reserve,
            )
          )
            available.set(model, {
              id: model,
              label: config.display_name,
              default: config.default_chat,
            });
        }
      }
    }
    return {
      mode: gpt,
      claude: anthropicApiEnabled(),
      models: [...available.keys()],
      catalog: [...available.values()],
      allowTextAttachments: policy.allowTextAttachments,
      quota: {
        daily: Math.max(0, quota.limits.daily - spend.daily),
        monthly: Math.max(0, quota.limits.monthly - spend.monthly),
        concurrency: Math.min(
          quota.concurrency,
          (await readAiQuota(req.actor.id)).concurrency,
        ),
        dailyTokens: Math.max(0, quota.dailyTokens - spend.dayTokens),
        charged: spend.charged,
        input: spend.input,
        output: spend.output,
      },
    };
  });
  app.get('/api/ai/platform/usage', async (req, reply) => {
    if (!platformAccountsEnabled()) return [];
    reply.header('Cache-Control', 'no-store');
    return sql`select l.task_id as id,l.model,l.input_tokens,l.cached_tokens,l.cache_write_tokens,
      l.output_tokens,l.charged_micros,l.reserved_micros,l.created_at,t.data->>'status' as status
      from ai_platform_usage l join ai_tasks t on t.id=l.task_id and t.owner_id=l.user_id
      where l.user_id=${req.actor.id} order by l.created_at desc limit 100`;
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
      models: (
        await sql`select model_id from ai_platform_models order by model_id`
      ).map((m) => m.model_id),
      policy,
      usage: await budget(sql, {}, policy.timeZone),
      accounts: await Promise.all(
        rows.map(async (row) => ({
          ...mapAdminAccount(row),
          usage: await budget(sql, { account: row.id }, policy.timeZone),
        })),
      ),
    };
  });
  app.get('/api/admin/ai-platform/models', async (req, reply) => {
    owner(req.actor);
    reply.header('Cache-Control', 'no-store');
    return sql`select m.*, (select count(*)::int from ai_platform_accounts a
      where a.enabled and a.health='READY' and m.model_id=any(a.models)) as ready_accounts,
      (select coalesce(sum(input_tokens+output_tokens),0) from ai_platform_usage l where l.model=m.model_id) as usage_tokens
      from ai_platform_models m order by m.display_name,m.model_id`;
  });
  app.put('/api/admin/ai-platform/models/:id', async (req) => {
    owner(req.actor);
    const { id } = z.object({ id: models }).parse(req.params);
    const d = platformModelConfig.parse(req.body);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      if (d.defaultChat)
        await tx`update ai_platform_models set default_chat=false where default_chat`;
      await tx`insert into ai_platform_models(model_id,display_name,enabled,supports_chat,
        default_chat,allowed_users,pricing,task_micros)
        values(${id},${d.displayName},${d.enabled},${d.supportsChat},${d.defaultChat},
          ${d.allowedUsers},${tx.json(d.pricing)},${d.taskMicros})
        on conflict(model_id) do update set display_name=excluded.display_name, enabled=excluded.enabled,
        supports_chat=excluded.supports_chat,
        default_chat=excluded.default_chat,
        allowed_users=excluded.allowed_users, pricing=excluded.pricing, task_micros=excluded.task_micros`;
    });
    await audit(req.actor.id, 'ai.platform_model_updated', id);
    return { ok: true };
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
      (project_id,service_account_id,name,note,models,secret,daily_micros,monthly_micros,concurrency,priority,allowed_users,health)
      values (${d.projectId},${d.serviceAccountId},${d.name},${d.note},${d.models},${sql.json(seal(d.apiKey))},
        ${d.limits.daily},${d.limits.monthly},${d.concurrency},${d.priority},${d.allowedUsers},'CHECK_PENDING')
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
      .extend({
        allowedUsers: audience.optional(),
        priority: z.number().int().min(1).max(1000).optional(),
      })
      .parse(req.body);
    const [r] = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      return tx`update ai_platform_accounts set name=${d.name},note=${d.note},
        enabled=${d.enabled} and health='READY' and secret is not null and models=${d.models},
        health=case when models<>${d.models} and secret is not null then 'UNCHECKED' else health end,
        revision=revision+1, models=${d.models}, daily_micros=${d.limits.daily},
        monthly_micros=${d.limits.monthly}, concurrency=${d.concurrency}, priority=coalesce(${d.priority ?? null},priority),
        allowed_users=case when ${d.allowedUsers !== undefined} then ${d.allowedUsers ?? null}::uuid[] else allowed_users end
        where id=${id} returning id,enabled`;
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

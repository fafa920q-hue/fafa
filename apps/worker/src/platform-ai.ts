import {
  modelForUser,
  pricing,
} from '../../../packages/auth/src/platform-models';
import OpenAI from 'openai';
import { sql } from '../../../packages/db/src';
import { unseal } from '../../../packages/shared/src/crypto';
import {
  platformAiEnabled,
  platformCost,
  platformModels,
  type PlatformModel,
} from '../../../packages/shared/src/platform-ai';
import {
  allowed,
  configuration,
  budget,
  fits,
} from '../../../packages/auth/src/platform-ai';

function clientFor(account: any, timeout: number) {
  return new OpenAI({
    apiKey: unseal(account.secret),
    project: account.project_id,
    baseURL: 'https://api.openai.com/v1',
    logLevel: 'off',
    maxRetries: 0,
    timeout,
  });
}

export async function checkPlatformAccount() {
  if (!platformAiEnabled() || process.env.DEMO_MODE === 'true') return;
  const account = await sql.begin(async (tx) => {
    const [row] =
      await tx`select id, secret, revision, models, project_id from ai_platform_accounts
      where secret is not null and (health='CHECK_PENDING' or
        (health='CHECK_RUNNING' and checked_at<now()-interval '1 minute'))
      order by id for update skip locked limit 1`;
    if (row)
      await tx`update ai_platform_accounts set health='CHECK_RUNNING',checked_at=now() where id=${row.id}`;
    return row;
  });
  if (!account) return;
  let error: string | null = null;
  try {
    const client = clientFor(account, 8000);
    const signal = AbortSignal.timeout(30_000);
    for (const model of account.models) {
      await client.models.retrieve(model, { signal });
      await client.responses.inputTokens.count(
        { model, input: 'FAFA ONE service model access check' },
        { signal },
      );
    }
  } catch (e) {
    error =
      e instanceof OpenAI.APIError && e.status
        ? 'HTTP_' + e.status
        : 'CONNECTION_FAILED';
  }
  await sql`update ai_platform_accounts set health=${error ? 'ERROR' : 'READY'},checked_at=now(),last_error=${error}
    where id=${account.id} and revision=${account.revision} and health='CHECK_RUNNING'`;
}

export async function platformTaskAccount(task: any, user: any, db: any = sql) {
  if (
    !platformAiEnabled() ||
    process.env.DEMO_MODE === 'true' ||
    !allowed(user)
  )
    return;
  const { policy, quota } = await configuration(db, user.id);
  if (
    !policy.enabled ||
    !quota.enabled ||
    !quota.models.includes(task.data.model)
  )
    return;
  const model = await modelForUser(db, task.data.model, user.id);
  if (!model) return;
  const [row] =
    await db`select a.id, a.secret, a.project_id, a.daily_micros, a.monthly_micros, l.reserved_micros, l.pricing
    from ai_platform_accounts a join ai_platform_usage l on l.account_id=a.id
    where a.id=${task.platform_account_id} and a.enabled and a.health='READY' and a.secret is not null
    and a.revision=l.account_revision and l.task_id=${task.id} and l.user_id=${task.owner_id}
    and l.model=${task.data.model} and l.model=any(a.models)
    and l.reserved_micros <= ${Math.min(quota.task, Number(model.task_micros))}
    and (a.allowed_users is null or l.user_id=any(a.allowed_users))
    and not exists (select 1 from settings where key='platform_ai_pause:' || a.project_id
      and (value #>> '{}')::timestamptz > now())`;
  return row;
}

export async function startPlatformTask(
  task: any,
  user: any,
  signal: AbortSignal,
) {
  const account = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77708)`;
    const [running] =
      await tx`select id from ai_tasks where id=${task.id} and data->>'status'='RUNNING' for update`;
    if (!running || signal.aborted) throw Error('PLATFORM_TASK_CLOSED');
    const account = await platformTaskAccount(task, user, tx);
    if (!account) throw Error('PLATFORM_TASK_CLOSED');
    const { policy, quota } = await configuration(tx, user.id);
    const global = await budget(tx, {}, policy.timeZone);
    if (
      (policy.routing === 'PROJECT' && policy.target !== account.project_id) ||
      (policy.routing === 'ACCOUNT' && policy.target !== account.id) ||
      global.monthly > policy.globalMonthly ||
      global.daily > policy.globalDaily ||
      !fits(
        await budget(tx, { user: user.id }, policy.timeZone),
        quota.limits,
        0,
      ) ||
      !fits(
        await budget(tx, { project: account.project_id }, policy.timeZone),
        policy.project,
        0,
      ) ||
      !fits(
        await budget(tx, { account: account.id }, policy.timeZone),
        {
          daily: Number(account.daily_micros),
          monthly: Number(account.monthly_micros),
        },
        0,
      )
    )
      throw Error('PLATFORM_BUDGET_CHANGED');
    const [dispatch] = await tx`update ai_platform_usage set dispatched_at=now()
      where task_id=${task.id} and dispatched_at is null and charged_micros is null
        and created_at >= date_trunc('day', now(), ${policy.timeZone})
      returning task_id`;
    if (!dispatch) throw Error('PLATFORM_RESERVATION_EXPIRED');
    return account;
  });
  const client = clientFor(account, 120000);
  const rate = pricing.parse(
    account.pricing ?? platformModels[task.data.model as PlatformModel],
  );
  const input = task.chat_id
    ? await chatInput(task)
    : (task.data.prompt as string);
  if (task.chat_id) {
    const count = await client.responses.inputTokens.count(
      { model: task.data.model, input },
      { signal },
    );
    if (count.input_tokens > rate.context) throw Error('PLATFORM_INPUT_LIMIT');
  } else if (Buffer.byteLength(input as string) + 128 > rate.context) {
    throw Error('PLATFORM_INPUT_LIMIT');
  }
  return client.responses.create(
    {
      model: task.data.model,
      input,
      max_output_tokens: task.data.maxOutputTokens,
      stream: true,
      store: false,
      service_tier: 'default',
    },
    { signal },
  );
}

async function chatInput(task: any): Promise<OpenAI.Responses.ResponseInput> {
  const root = task.data.turnRoot ?? task.id;
  const rows = await sql`select data from (
    select distinct on (coalesce(t.data->>'turnRoot',t.id::text)) t.id,t.data,t.created_at
    from ai_tasks t join ai_platform_chats c on c.id=t.chat_id and c.owner_id=t.owner_id
    where c.id=${task.chat_id} and c.owner_id=${task.owner_id} and c.deleted_at is null
      and t.revoked_at is null and coalesce(t.data->>'turnRoot',t.id::text)<>${root}
      and t.data->>'status'='COMPLETED'
    order by coalesce(t.data->>'turnRoot',t.id::text),t.created_at desc,t.id desc
  ) variants order by created_at desc,id desc limit 20`;
  const context: OpenAI.Responses.ResponseInput = [];
  let bytes = Buffer.byteLength(task.data.prompt);
  for (const { data } of rows) {
    bytes +=
      Buffer.byteLength(data.prompt || '') +
      Buffer.byteLength(data.output || '');
    if (bytes > 128_000) break;
    context.unshift(
      { role: 'user', content: data.prompt },
      { role: 'assistant', content: data.output },
    );
  }
  context.push({ role: 'user', content: task.data.prompt });
  return context;
}

export async function settlePlatformUsage(
  task: any,
  response: {
    id: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details: {
        cached_tokens: number;
        cache_write_tokens?: number;
      };
    } | null;
  },
) {
  const u = response.usage;
  if (!u) return;
  const [ledger] =
    await sql`select pricing from ai_platform_usage where task_id=${task.id}`;
  const rate = pricing.safeParse(
    ledger?.pricing ?? platformModels[task.data.model as PlatformModel],
  );
  if (!rate.success) return;
  const input = u.input_tokens,
    output = u.output_tokens,
    cached = u.input_tokens_details.cached_tokens,
    cacheWrite = u.input_tokens_details.cache_write_tokens ?? 0;
  if (
    ![input, output, cached, cacheWrite].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 2_147_483_647,
    ) ||
    cached + cacheWrite > input
  )
    return;
  const charged = platformCost(rate.data, input, cached, output, cacheWrite);
  await sql.begin(async (tx) => {
    const [record] =
      await tx`update ai_platform_usage set input_tokens=${input}, cached_tokens=${cached},
      output_tokens=${output}, cache_write_tokens=${cacheWrite}, response_id=${response.id}, charged_micros=${charged}
      where task_id=${task.id} and dispatched_at is not null and charged_micros is null
      returning reserved_micros`;
    if (record && charged > Number(record.reserved_micros))
      await tx`update ai_platform_accounts set health='ERROR',enabled=false,last_error='USAGE_EXCEEDED_RESERVATION'
        where id=${task.platform_account_id}`;
  });
}

export async function recordPlatformError(task: any, error: unknown) {
  if (!(error instanceof OpenAI.APIError) || !error.status) return;
  if (error.status === 429) {
    const header = Number(error.headers?.get('retry-after'));
    const cooldown =
      Number.isFinite(header) && header > 60 ? Math.min(header, 86400) : 60;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(77708)`;
      const [ledger] =
        await tx`select project_id from ai_platform_usage where task_id=${task.id}`;
      if (!ledger) return;
      await tx`insert into settings(key,value) values (${'platform_ai_pause:' + ledger.project_id}, to_jsonb(now()+(${cooldown}::float8 * interval '1 second')))
        on conflict(key) do update set value=greatest(settings.value,excluded.value)`;
      await tx`update ai_platform_accounts set health='THROTTLED',last_error='HTTP_429'
        where project_id=${ledger.project_id} and health='READY'`;
    });
  } else if ([401, 403, 404].includes(error.status)) {
    await sql`update ai_platform_accounts a set health='ERROR', enabled=false,last_error=${'HTTP_' + error.status}
      from ai_platform_usage l where l.task_id=${task.id} and a.id=l.account_id and a.revision=l.account_revision`;
  }
}

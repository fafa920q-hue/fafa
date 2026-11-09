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
    for (const model of account.models) await client.models.retrieve(model);
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
  const [row] =
    await db`select a.id, a.secret, a.project_id, a.daily_micros, a.monthly_micros, l.reserved_micros
    from ai_platform_accounts a join ai_platform_usage l on l.account_id=a.id
    where a.id=${task.platform_account_id} and a.enabled and a.health='READY' and a.secret is not null
    and a.revision=l.account_revision and l.task_id=${task.id} and l.user_id=${task.owner_id}
    and l.model=${task.data.model} and l.model=any(a.models)
    and l.reserved_micros <= ${quota.task}
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
    if (
      (policy.routing === 'PROJECT' && policy.target !== account.project_id) ||
      (policy.routing === 'ACCOUNT' && policy.target !== account.id) ||
      (await budget(tx)).monthly > policy.globalMonthly ||
      !fits(await budget(tx, { user: user.id }), quota.limits, 0) ||
      !fits(
        await budget(tx, { project: account.project_id }),
        policy.project,
        0,
      ) ||
      !fits(
        await budget(tx, { account: account.id }),
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
        and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
      returning task_id`;
    if (!dispatch) throw Error('PLATFORM_RESERVATION_EXPIRED');
    return account;
  });
  return clientFor(account, 120000).responses.create(
    {
      model: task.data.model,
      input: task.data.prompt,
      max_output_tokens: task.data.maxOutputTokens,
      stream: true,
      store: false,
      service_tier: 'default',
    },
    { signal },
  );
}

export async function settlePlatformUsage(
  task: any,
  response: {
    id: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details: { cached_tokens: number };
    } | null;
  },
) {
  const model = task.data.model as PlatformModel;
  const u = response.usage;
  if (!u || !Object.hasOwn(platformModels, model)) return;
  const input = u.input_tokens,
    output = u.output_tokens,
    cached = u.input_tokens_details.cached_tokens;
  if (
    ![input, output, cached].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 2_147_483_647,
    ) ||
    cached > input
  )
    return;
  const charged = platformCost(model, input, cached, output);
  await sql.begin(async (tx) => {
    const [record] =
      await tx`update ai_platform_usage set input_tokens=${input}, cached_tokens=${cached},
      output_tokens=${output}, response_id=${response.id}, charged_micros=${charged}
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

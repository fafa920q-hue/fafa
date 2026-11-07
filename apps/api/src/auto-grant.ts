import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { AppError } from '../../../packages/shared/src';
import { token, hash } from '../../../packages/shared/src/crypto';

// 新用户前三天自动授权：共享逻辑（管理后台接口与注册资格判断共用）。
// 授权本身复用 node_group_grants / server_access_grants / subscription_tokens，
// auto_grant_records 只记成功 / 待分配 / 失败轨迹，不构成第二套权限系统。
// 体验服务器只授予管理员在策略中指定的那一个服务器，绝不自动授予其他服务器；
// 交互式终端保持关闭（SSH_INTERACTIVE_ENABLED=false），自动授权永不批准写终端。

export const AUTO_GRANT_POLICY_KEYS = [
  'auto_grant_enabled',
  'auto_grant_window_start',
  'auto_grant_window_end',
  'auto_grant_node_source_id',
  'auto_grant_server_id',
  'auto_grant_node_limit',
  'auto_grant_trial_valid_days',
] as const;

export const autoGrantPolicySchema = z
  .object({
    enabled: z.boolean(),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    nodeSourceId: z.uuid().nullable(),
    serverId: z.uuid().nullable(),
    nodeLimit: z.number().int().min(0).max(5000).nullable(),
    trialValidDays: z.number().int().min(1).max(30),
  })
  .refine((d) => new Date(d.windowStart) < new Date(d.windowEnd), {
    message: '活动结束时间必须晚于开始时间',
  });

export type AutoGrantPolicy = z.infer<typeof autoGrantPolicySchema>;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const WINDOW_START_DEFAULT = '2026-11-07T13:33:00Z';
const WINDOW_END_DEFAULT = '2026-11-10T13:33:00Z';

export async function readAutoGrantPolicy(): Promise<AutoGrantPolicy> {
  const rows = await sql`select key,value from settings where key in ${sql([
    ...AUTO_GRANT_POLICY_KEYS,
  ])}`;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    enabled: map.get('auto_grant_enabled') === true,
    windowStart: String(
      map.get('auto_grant_window_start') ?? WINDOW_START_DEFAULT,
    ),
    windowEnd: String(map.get('auto_grant_window_end') ?? WINDOW_END_DEFAULT),
    nodeSourceId:
      (map.get('auto_grant_node_source_id') as string | null) ?? null,
    serverId: (map.get('auto_grant_server_id') as string | null) ?? null,
    nodeLimit: (map.get('auto_grant_node_limit') as number | null) ?? null,
    trialValidDays: Number(map.get('auto_grant_trial_valid_days') ?? 3),
  };
}

type GrantStatus = 'GRANTED' | 'PENDING' | 'FAILED';

async function record(
  userId: string,
  kind: 'node' | 'server' | 'token',
  resourceId: string,
  status: GrantStatus,
  reason: string | null,
  expiresAt: string | null,
) {
  await sql`insert into auto_grant_records(user_id,kind,resource_id,status,reason,expires_at,granted_at) values(${userId},${kind},${resourceId},${status},${reason},${expiresAt},${status === 'GRANTED' ? new Date().toISOString() : null}) on conflict (user_id,kind,resource_id) do update set status=excluded.status,reason=excluded.reason,expires_at=excluded.expires_at,granted_at=excluded.granted_at,updated_at=now()`;
}

function trialExpiry(policy: AutoGrantPolicy) {
  return new Date(Date.now() + policy.trialValidDays * 86400000).toISOString();
}

function redistributionOk(data: Record<string, unknown>) {
  return (
    data.kind === 'OWNED_NODE' ||
    (data.authorized === true &&
      data.redistributionAuthorized === true &&
      typeof data.authorizationReference === 'string' &&
      data.authorizationReference.trim().length > 0)
  );
}

async function grantNode(userId: string, policy: AutoGrantPolicy) {
  if (!policy.nodeSourceId) {
    await record(
      userId,
      'node',
      ZERO_UUID,
      'PENDING',
      'NODE_SOURCE_NOT_CONFIGURED',
      null,
    );
    return { kind: 'node', status: 'PENDING' as GrantStatus };
  }
  const [source] =
    await sql`select id,owner_id,data from node_sources where id=${policy.nodeSourceId} and revoked_at is null`;
  if (!source) {
    await record(
      userId,
      'node',
      policy.nodeSourceId,
      'FAILED',
      'NODE_SOURCE_NOT_FOUND',
      null,
    );
    return { kind: 'node', status: 'FAILED' as GrantStatus };
  }
  if (!redistributionOk(source.data)) {
    await record(
      userId,
      'node',
      policy.nodeSourceId,
      'FAILED',
      'REDISTRIBUTION_REQUIRED',
      null,
    );
    return { kind: 'node', status: 'FAILED' as GrantStatus };
  }
  await sql`insert into node_group_grants(owner_id,source_id,user_id,data) values(${source.owner_id},${policy.nodeSourceId},${userId},${sql.json({ scope: 'USE', autoGranted: true })}) on conflict do nothing`;
  await record(
    userId,
    'node',
    policy.nodeSourceId,
    'GRANTED',
    null,
    trialExpiry(policy),
  );
  return { kind: 'node', status: 'GRANTED' as GrantStatus };
}

async function grantServer(userId: string, policy: AutoGrantPolicy) {
  if (!policy.serverId) {
    await record(
      userId,
      'server',
      ZERO_UUID,
      'PENDING',
      'SERVER_NOT_CONFIGURED',
      null,
    );
    return { kind: 'server', status: 'PENDING' as GrantStatus };
  }
  const [server] =
    await sql`select id,owner_id from server_connections where id=${policy.serverId} and revoked_at is null`;
  if (!server) {
    await record(
      userId,
      'server',
      policy.serverId,
      'FAILED',
      'SERVER_NOT_FOUND',
      null,
    );
    return { kind: 'server', status: 'FAILED' as GrantStatus };
  }
  await sql`insert into server_access_grants(owner_id,server_id,user_id,data) values(${server.owner_id},${policy.serverId},${userId},${sql.json({ scope: 'USE', autoGranted: true })}) on conflict do nothing`;
  await record(
    userId,
    'server',
    policy.serverId,
    'GRANTED',
    null,
    trialExpiry(policy),
  );
  return { kind: 'server', status: 'GRANTED' as GrantStatus };
}

async function grantToken(userId: string) {
  const [existing] =
    await sql`select id from subscription_tokens where owner_id=${userId} and revoked_at is null`;
  if (!existing) {
    await sql`insert into subscription_tokens(owner_id,token_hash,data) values(${userId},${hash(token())},${sql.json({ enabled: true })})`;
  }
  await record(userId, 'token', ZERO_UUID, 'GRANTED', null, null);
  return { kind: 'token', status: 'GRANTED' as GrantStatus };
}

async function grantAll(userId: string, policy: AutoGrantPolicy) {
  if (policy.nodeLimit !== null && policy.nodeLimit !== undefined) {
    await sql`update users set node_limit=${policy.nodeLimit},updated_at=now() where id=${userId}`;
  }
  const node = await grantNode(userId, policy);
  const server = await grantServer(userId, policy);
  const tokenResult = await grantToken(userId);
  return [node, server, tokenResult];
}

// 注册成功后的自动授权入口（供 Codex 的注册资格判断调用）。
// 只看用户创建时间是否在窗口内，不看“现在”是否在窗口内之外的条件；
// 策略开关与“现在在窗口内”是实时授权的门槛，补处理走 backfillAutoGrants。
export async function applyAutoGrant(userId: string) {
  const policy = await readAutoGrantPolicy();
  const [user] =
    await sql`select id,role,disabled,created_at from users where id=${userId} and deleted_at is null`;
  if (!user) return { applied: false, reason: 'USER_NOT_FOUND' };
  if (user.role !== 'Member' || user.disabled)
    return { applied: false, reason: 'ROLE_NOT_ELIGIBLE' };
  if (!policy.enabled) return { applied: false, reason: 'POLICY_DISABLED' };
  const now = new Date();
  if (now < new Date(policy.windowStart) || now >= new Date(policy.windowEnd))
    return { applied: false, reason: 'OUTSIDE_WINDOW' };
  if (
    new Date(user.created_at) < new Date(policy.windowStart) ||
    new Date(user.created_at) >= new Date(policy.windowEnd)
  )
    return { applied: false, reason: 'USER_CREATED_OUTSIDE_WINDOW' };
  return { applied: true, results: await grantAll(userId, policy) };
}

// 安全补处理：只补窗口期内真实新注册的 Member 用户，不纳入老用户。
// 要求策略已开启（管理员显式开启即授权补处理）；幂等，重复触发不重复授权。
export async function backfillAutoGrants(actorId: string) {
  const policy = await readAutoGrantPolicy();
  if (!policy.enabled)
    throw new AppError(
      400,
      'POLICY_DISABLED',
      '请先开启自动授权策略，再进行补处理',
    );
  const users =
    await sql`select id from users where role='Member' and not disabled and deleted_at is null and created_at >= ${policy.windowStart} and created_at < ${policy.windowEnd} order by created_at`;
  const summary = {
    scanned: users.length,
    granted: 0,
    pending: 0,
    failed: 0,
    users: [] as {
      userId: string;
      results: { kind: string; status: GrantStatus }[];
    }[],
  };
  for (const u of users) {
    const results = await grantAll(u.id, policy);
    for (const r of results) {
      if (r.status === 'GRANTED') summary.granted += 1;
      else if (r.status === 'PENDING') summary.pending += 1;
      else summary.failed += 1;
    }
    summary.users.push({ userId: u.id, results });
  }
  await audit(actorId, 'auto_grant.backfilled', null);
  return summary;
}

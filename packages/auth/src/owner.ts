import { randomUUID } from 'node:crypto';
import { sql } from '../../db/src';
import { hash, token } from '../../shared/src/crypto';
import { AppError } from '../../shared/src';
export async function issueOwnerCredential() {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77702)`;
    const [state] = await tx`select closed from owner_initialization where singleton for update`;
    const owners = await tx`select id from users where role='Owner' and deleted_at is null`;
    if (!state || state.closed || owners.length) throw Error('Owner 初始化已永久关闭');
    const id = randomUUID();
    const raw = id + '.' + token();
    await tx`update owner_setup_credentials set expires_at=now()`;
    await tx`insert into owner_setup_credentials(id,token_hash,expires_at) values(${id},${hash(raw)},now()+interval '15 minutes')`;
    return raw;
  });
}
export async function beginOwnerCredential(raw: string, state: string) {
  const id = raw.split('.')[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new AppError(403, 'OWNER_AUTHORIZATION', '初始化授权无效或已失效');
  const [result] = await sql`select begin_owner_setup(${id}::uuid,${hash(raw)},${hash(state)}) as allowed`;
  if (!result.allowed)
    throw new AppError(403, 'OWNER_AUTHORIZATION', '初始化授权无效或已失效');
  return id;
}
export async function completeOwnerCredential(id: string, state: string, payload: {
  sub: string; email?: string; email_verified?: boolean; name?: string;
}) {
  if (!payload.email || !payload.email_verified)
    throw new AppError(403, 'EMAIL_UNVERIFIED', '需要已验证的 Google 邮箱');
  try {
    const [result] = await sql`select complete_owner_setup(${id}::uuid,${hash(state)},${payload.sub},${payload.email},${payload.name || 'Owner'}) as id`;
    const [user] = await sql`select * from users where id=${result.id}`;
    return user;
  } catch {
    throw new AppError(403, 'OWNER_AUTHORIZATION', '初始化授权无效或已永久关闭');
  }
}
export async function ownerSetupAvailable() {
  const [result] = await sql`select owner_setup_available() as available`;
  return result.available === true;
}

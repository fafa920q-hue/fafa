import { applyAutoGrant } from './auto-grant';
import { selfServiceRegistration } from './self-service';
import { assertPublicUrls, googleRedirectUri } from './urls';
import { OAuth2Client } from 'google-auth-library';
import { sql } from '../../db/src';
import { token, hash } from '../../shared/src/crypto';
import { AppError, type User } from '../../shared/src';
export function mockEnabled() {
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_MOCK_LOGIN === 'true'
  );
}
export function assertEnvironment() {
  assertPublicUrls();
  if (
    process.env.NODE_ENV === 'production' &&
    (process.env.DEV_MOCK_LOGIN === 'true' || process.env.DEMO_MODE === 'true')
  )
    throw Error('生产环境禁止演示与开发登录');
  if (!process.env.ENCRYPTION_KEY)
    throw Error('缺少 ENCRYPTION_KEY，请执行初始化');
}
export const google = () =>
  new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri(),
  );
export async function activateGoogle(payload: {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}) {
  if (!payload.email || !payload.email_verified)
    throw new AppError(403, 'EMAIL_UNVERIFIED', '需要已验证的 Google 邮箱');
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77702)`;
    const [existing] =
      await tx`select u.* from users u join google_identities g on g.user_id=u.id where g.sub=${payload.sub}`;
    if (existing) {
      if (existing.role === 'Owner') {
        const [binding] =
          await tx`select owner_identity_allowed(${payload.sub}) as allowed`;
        if (!binding.allowed)
          throw new AppError(403, 'OWNER_IDENTITY', 'Owner 身份不匹配');
      }
      if (existing.disabled || existing.deleted_at)
        throw new AppError(403, 'DISABLED', '账户已停用');
      return existing as User;
    }
    // Never merge by email: a password account must explicitly prove both identities.
    const emailConflict = await tx.unsafe(
      'SELECT id FROM users WHERE lower(email)=lower($1)',
      [payload.email!],
    );
    if (emailConflict.length)
      throw new AppError(
        403,
        'GOOGLE_LINK_REQUIRED',
        '请先登录原账户，再从账户安全页面绑定 Google',
      );
    const [invite] =
      await tx`select * from invitations where lower(data->>'email')=lower(${payload.email!}) and revoked_at is null and (data->>'expiresAt')::timestamptz>now() and not (data ? 'usedAt') for update`;
    const [registration] = await tx.unsafe(
      "SELECT value FROM settings WHERE key='member_registration_open'",
    );
    if (selfServiceRegistration() && registration?.value !== true)
      throw new AppError(403, 'REGISTRATION_CLOSED', '当前暂未开放注册');
    if (!selfServiceRegistration() && !invite && registration?.value !== true)
      throw new AppError(403, 'INVITE_REQUIRED', '此账号尚未受邀');
    const [limit] = await tx`select value from settings where key='seat_limit'`;
    const [count] =
      await tx`select count(*)::int as total from users where deleted_at is null`;
    if (count.total >= Number(limit.value))
      throw new AppError(409, 'SEAT_LIMIT', '用户席位已满');
    const role = selfServiceRegistration()
      ? 'Member'
      : invite
        ? invite.data.role
        : 'Member';
    if (!['Admin', 'Member', 'Viewer'].includes(role))
      throw new AppError(403, 'INVITE_ROLE', '邀请角色无效');
    const [u] =
      await tx`insert into users(email,name,role) values(${payload.email!},${payload.name || 'Google 用户'},${role}) returning *`;
    await tx`insert into google_identities(user_id,sub) values(${u.id},${payload.sub})`;
    await tx`insert into subscription_tokens(owner_id,token_hash,data) values(${u.id},${hash(token())},${tx.json({ enabled: true })})`;
    if (invite && !selfServiceRegistration())
      await tx`update invitations set data=data || ${tx.json({ usedAt: new Date().toISOString() })} where id=${invite.id}`;
    await applyAutoGrant(u.id, tx);
    return u as User;
  });
}
export async function createSession(user: User, expectedPasswordHash?: string) {
  const raw = token();
  const csrf = token();
  await sql.begin(async (tx) => {
    const [current] =
      await tx`select id from users where id=${user.id} and role=${user.role} and not disabled and deleted_at is null for update`;
    if (!current)
      throw new AppError(401, 'LOGIN_INVALID', '账户状态已变化，请重新登录');
    if (expectedPasswordHash) {
      const [credential] =
        await tx`select password_hash from member_credentials where user_id=${user.id} for update`;
      if (!credential || credential.password_hash !== expectedPasswordHash)
        throw new AppError(401, 'LOGIN_INVALID', '密码已变化，请重新登录');
    }
    await tx`insert into sessions(owner_id,token_hash,csrf,expires_at) values (${user.id},${hash(raw)},${csrf},now()+interval '7 days')`;
    await tx`insert into audit_events(owner_id,action) values(${user.id},'session.created')`;
  });
  return { raw, csrf };
}
export async function authenticate(raw?: string) {
  if (!raw) return null;
  const [row] =
    await sql`select u.*,s.id as session_id,s.csrf,s.reauthenticated_at from sessions s join users u on u.id=s.owner_id where s.token_hash=${hash(raw)} and s.revoked_at is null and s.expires_at>now() and s.last_seen_at>now()-interval '30 minutes' and not u.disabled and u.deleted_at is null`;
  if (!row) return null;
  await sql`update sessions set last_seen_at=now() where id=${row.session_id}`;
  return row as User & {
    session_id: string;
    csrf: string;
    reauthenticated_at: Date;
  };
}

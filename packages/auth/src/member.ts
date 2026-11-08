import { sql } from '../../db/src';
import { AppError, type User } from '../../shared/src';
import { hash, token } from '../../shared/src/crypto';
import { hashPassword, verifyPassword } from './password';
import { requireAccountMail, queueAccountMail } from './member-mail';
import { applyAutoGrant } from './auto-grant';

export const genericMailMessage =
  '若资料符合条件，系统将尝试发送邮件。请查看收件箱；未收到可稍后重试。';
const invalidLogin = () =>
  new AppError(
    401,
    'LOGIN_INVALID',
    '用户名、邮箱或密码不正确，或账户暂不可用',
  );
const invalidAction = () =>
  new AppError(
    400,
    'ACTION_INVALID',
    '链接或密码无效、已使用或已过期，请重新发起申请',
  );
export const memberUser = (user: any): User => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  disabled: user.disabled,
});
export async function authBudget(
  scope: string,
  identifier: string,
  max = 10,
  seconds = 900,
) {
  const [bucket] = await sql.unsafe(
    "INSERT INTO member_auth_buckets(key_hash,hits) VALUES($1,1) ON CONFLICT(key_hash) DO UPDATE SET hits=CASE WHEN member_auth_buckets.window_start<now()-($2::int*interval '1 second') THEN 1 ELSE member_auth_buckets.hits+1 END,window_start=CASE WHEN member_auth_buckets.window_start<now()-($2::int*interval '1 second') THEN now() ELSE member_auth_buckets.window_start END RETURNING hits",
    [hash(scope + ':' + identifier), seconds],
  );
  if (bucket.hits > max)
    throw new AppError(429, 'AUTH_RATE_LIMIT', '操作过于频繁，请稍后重试');
}
async function registrationAvailable(tx: any) {
  const [open] = await tx.unsafe(
    "SELECT value FROM settings WHERE key='member_registration_open'",
  );
  if (open?.value !== true)
    throw new AppError(
      403,
      'REGISTRATION_CLOSED',
      '当前未开放普通用户注册，请联系管理员',
    );
  const [limit] = await tx.unsafe(
    "SELECT value FROM settings WHERE key='seat_limit'",
  );
  const [count] = await tx.unsafe(
    'SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL',
  );
  if (count.total >= Number(limit?.value || 20))
    throw new AppError(409, 'SEAT_LIMIT', '当前注册名额已满，请稍后再试');
}
function sendMail(
  to: string,
  raw: string,
  purpose: 'VERIFY' | 'RESET',
  owner: string | null,
) {
  queueAccountMail({ to, raw, purpose }, async () => {
    const table =
      purpose === 'VERIFY' ? 'member_registrations' : 'member_action_tokens';
    await sql.unsafe(
      'UPDATE ' +
        table +
        ' SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL',
      [hash(raw)],
    );
    await sql.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.mail_failed')",
      [owner],
    );
  });
}
export async function registerMember(data: {
  username: string;
  email: string;
  password: string;
}) {
  await registrationAvailable(sql);
  requireAccountMail();
  await authBudget('registration-email', data.email, 3, 3600);
  await authBudget('registration-username', data.username, 6, 3600);
  const passwordHash = await hashPassword(data.password);
  const raw = token();
  const created = await sql.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
    await registrationAvailable(tx);
    const existing = await tx.unsafe(
      'SELECT id FROM users WHERE lower(email)=$1 UNION ALL SELECT user_id AS id FROM member_credentials WHERE username=$2 OR email_key=$1 UNION ALL SELECT id FROM member_registrations WHERE (email_key=$1 OR username=$2) AND consumed_at IS NULL AND expires_at>now()',
      [data.email, data.username],
    );
    if (existing.length) return false;
    await tx.unsafe(
      "INSERT INTO member_registrations(username,email_key,password_hash,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes')",
      [data.username, data.email, passwordHash, hash(raw)],
    );
    return true;
  });
  if (created) sendMail(data.email, raw, 'VERIFY', null);
}
export async function resendVerification(email: string, password: string) {
  requireAccountMail();
  await authBudget('verification-resend', email, 3, 3600);
  const [pending] = await sql.unsafe(
    'SELECT * FROM member_registrations WHERE email_key=$1 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1',
    [email],
  );
  const valid = await verifyPassword(password, pending?.password_hash);
  if (!valid || !pending) return;
  const raw = token();
  const updated = await sql.unsafe(
    "UPDATE member_registrations SET token_hash=$1,expires_at=now()+interval '30 minutes' WHERE id=$2 AND token_hash=$3 AND consumed_at IS NULL RETURNING id",
    [hash(raw), pending.id, pending.token_hash],
  );
  if (updated.length) sendMail(email, raw, 'VERIFY', null);
}
export async function verifyRegistration(raw: string, password: string) {
  const [pending] = await sql.unsafe(
    'SELECT * FROM member_registrations WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()',
    [hash(raw)],
  );
  const valid = await verifyPassword(password, pending?.password_hash);
  if (!pending || !valid) throw invalidAction();
  const user = await sql.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
    await registrationAvailable(tx);
    const [current] = await tx.unsafe(
      'SELECT * FROM member_registrations WHERE id=$1 AND token_hash=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
      [pending.id, hash(raw)],
    );
    if (!current) throw invalidAction();
    const existing = await tx.unsafe(
      'SELECT id FROM users WHERE lower(email)=$1 UNION ALL SELECT user_id AS id FROM member_credentials WHERE username=$2 OR email_key=$1',
      [current.email_key, current.username],
    );
    if (existing.length) throw invalidAction();
    const [created] = await tx.unsafe(
      "INSERT INTO users(email,name,role) VALUES($1,$2,'Member') RETURNING *",
      [current.email_key, current.username],
    );
    await tx.unsafe(
      'INSERT INTO member_credentials(user_id,username,email_key,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
      [created.id, current.username, current.email_key, current.password_hash],
    );
    await tx.unsafe(
      'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
      [current.id],
    );
    await tx.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.email_verified')",
      [created.id],
    );
    await applyAutoGrant(created.id, tx);
    return memberUser(created);
  });
  queueAccountMail(
    { to: user.email, purpose: 'VERIFIED', ownerId: user.id },
    async () => {},
  );
  return user;
}
export async function loginMember(identifier: string, password: string) {
  await authBudget('password-login', identifier);
  const [user] = await sql.unsafe(
    'SELECT u.*,c.password_hash AS credential_hash FROM member_credentials c JOIN users u ON u.id=c.user_id WHERE c.username=$1 OR c.email_key=$1 LIMIT 1',
    [identifier],
  );
  const valid = await verifyPassword(password, user?.credential_hash);
  if (
    !valid ||
    !user ||
    user.disabled ||
    user.deleted_at ||
    user.role === 'Owner'
  )
    throw invalidLogin();
  const [current] = await sql.unsafe(
    "SELECT u.* FROM users u JOIN member_credentials c ON c.user_id=u.id WHERE u.id=$1 AND c.password_hash=$2 AND NOT u.disabled AND u.deleted_at IS NULL AND u.role<>'Owner'",
    [user.id, user.credential_hash],
  );
  if (!current) throw invalidLogin();
  return {
    user: memberUser(current),
    passwordHash: user.credential_hash as string,
  };
}
export async function requestPasswordReset(email: string) {
  requireAccountMail();
  await authBudget('password-reset-request', email, 3, 3600);
  const [user] = await sql.unsafe(
    "SELECT u.id,c.email_key FROM member_credentials c JOIN users u ON u.id=c.user_id WHERE c.email_key=$1 AND NOT u.disabled AND u.deleted_at IS NULL AND u.role<>'Owner'",
    [email],
  );
  if (!user) return;
  const raw = token();
  await sql.begin(async (tx) => {
    await tx.unsafe('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    await tx.unsafe(
      'UPDATE member_action_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [user.id],
    );
    await tx.unsafe(
      "INSERT INTO member_action_tokens(user_id,token_hash,purpose,expires_at) VALUES($1,$2,'PASSWORD_RESET',now()+interval '15 minutes')",
      [user.id, hash(raw)],
    );
  });
  sendMail(user.email_key, raw, 'RESET', user.id);
}
export async function resetMemberPassword(raw: string, password: string) {
  const passwordHash = await hashPassword(password);
  let recipient: { id: string; email_key: string } | undefined;
  await sql.begin(async (tx) => {
    const [action] = await tx.unsafe(
      "SELECT t.* FROM member_action_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.purpose='PASSWORD_RESET' AND t.consumed_at IS NULL AND t.expires_at>now() AND NOT u.disabled AND u.deleted_at IS NULL AND u.role<>'Owner' FOR UPDATE OF u,t",
      [hash(raw)],
    );
    if (!action) throw invalidAction();
    const [credential] = await tx.unsafe(
      'SELECT email_key FROM member_credentials WHERE user_id=$1',
      [action.user_id],
    );
    recipient = { id: action.user_id, email_key: credential.email_key };
    await tx.unsafe(
      'UPDATE member_credentials SET password_hash=$1,password_changed_at=now() WHERE user_id=$2',
      [passwordHash, action.user_id],
    );
    await tx.unsafe(
      'UPDATE member_action_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [action.user_id],
    );
    await tx.unsafe(
      'UPDATE sessions SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL',
      [action.user_id],
    );
    await tx.unsafe(
      'UPDATE member_google_links SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [action.user_id],
    );
    await tx.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.password_reset')",
      [action.user_id],
    );
  });
  if (recipient)
    queueAccountMail(
      {
        to: recipient.email_key,
        purpose: 'RESET_SUCCESS',
        ownerId: recipient.id,
      },
      async () => {},
    );
}
export async function confirmMemberPassword(id: string, password: string) {
  const [user] = await sql.unsafe(
    "SELECT c.password_hash FROM member_credentials c JOIN users u ON u.id=c.user_id WHERE u.id=$1 AND NOT u.disabled AND u.deleted_at IS NULL AND u.role<>'Owner'",
    [id],
  );
  if (!(await verifyPassword(password, user?.password_hash)))
    throw invalidLogin();
}
export async function createMemberGoogleLink(
  userId: string,
  sessionId: string,
  password: string,
) {
  await authBudget('google-link', userId, 5);
  await confirmMemberPassword(userId, password);
  const [row] = await sql.unsafe(
    'INSERT INTO member_google_links(user_id,session_id) VALUES($1,$2) RETURNING id',
    [userId, sessionId],
  );
  return row.id as string;
}
export async function completeMemberGoogleLink(
  id: string,
  sessionHash: string,
  payload: {
    sub: string;
    email?: string;
    email_verified?: boolean;
  },
) {
  if (!payload.email || payload.email_verified !== true)
    throw new AppError(
      403,
      'GOOGLE_LINK_INVALID',
      'Google 账户绑定验证失败，请重新发起',
    );
  return sql.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
    const [link] = await tx.unsafe(
      "SELECT l.*,c.email_key,u.* FROM member_google_links l JOIN sessions s ON s.id=l.session_id JOIN users u ON u.id=l.user_id JOIN member_credentials c ON c.user_id=u.id WHERE l.id=$1 AND l.consumed_at IS NULL AND l.expires_at>now() AND s.token_hash=$2 AND s.owner_id=l.user_id AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND NOT u.disabled AND u.deleted_at IS NULL AND u.role='Member' FOR UPDATE OF l,u",
      [id, sessionHash],
    );
    if (!link || link.email_key !== payload.email!.trim().toLowerCase())
      throw new AppError(
        403,
        'GOOGLE_LINK_INVALID',
        '请使用本人已验证邮箱对应的 Google 账户，并保持原登录会话',
      );
    const existing = await tx.unsafe(
      'SELECT user_id FROM google_identities WHERE sub=$1',
      [payload.sub],
    );
    if (existing.length && existing[0].user_id !== link.user_id)
      throw new AppError(
        403,
        'GOOGLE_LINK_INVALID',
        '此 Google 身份不能绑定到当前账户',
      );
    await tx.unsafe(
      'INSERT INTO google_identities(user_id,sub) VALUES($1,$2) ON CONFLICT(sub) DO NOTHING',
      [link.user_id, payload.sub],
    );
    await tx.unsafe(
      'UPDATE member_google_links SET consumed_at=now() WHERE id=$1',
      [id],
    );
    await tx.unsafe('UPDATE sessions SET revoked_at=now() WHERE id=$1', [
      link.session_id,
    ]);
    await tx.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.google_linked')",
      [link.user_id],
    );
    return memberUser({ ...link, id: link.user_id });
  });
}

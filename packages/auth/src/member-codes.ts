import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { sql } from '../../db/src';
import { AppError } from '../../shared/src';
import { hash, token } from '../../shared/src/crypto';
import { hashPassword, verifyPassword } from './password';
import { authBudget, memberUser } from './member';
import {
  deliverAccountMail,
  queueAccountMail,
  requireAccountMail,
} from './member-mail';
import { applyAutoGrant } from './auto-grant';

const error = (code: string, message: string, status = 400) =>
  new AppError(status, code, message);
function codeDigest(challenge: string, code: string) {
  if (!process.env.ENCRYPTION_KEY)
    throw error('AUTH_UNAVAILABLE', '认证服务暂不可用', 503);
  return createHmac('sha256', process.env.ENCRYPTION_KEY)
    .update('member-otp-v1:' + challenge + ':' + code)
    .digest('hex');
}
async function capacity(db: any) {
  const rows = await db.unsafe(
    "SELECT key,value FROM settings WHERE key IN ('member_registration_open','seat_limit')",
  );
  const open = rows.find((r: any) => r.key === 'member_registration_open');
  const limit = Number(
    rows.find((r: any) => r.key === 'seat_limit')?.value || 20,
  );
  if (open?.value !== true)
    throw error('REGISTRATION_CLOSED', '当前未开放普通用户注册', 403);
  const [count] = await db.unsafe(
    'SELECT count(*)::int AS total FROM users WHERE deleted_at IS NULL',
  );
  if (count.total >= limit) throw error('SEAT_LIMIT', '当前注册名额已满', 409);
}
export async function startCodeRegistration(data: {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
}) {
  await capacity(sql);
  requireAccountMail();
  if (data.password !== data.confirmPassword)
    throw error('PASSWORD_MISMATCH', '两次输入的密码不一致');
  await authBudget('registration-email', data.email, 3, 3600);
  await authBudget('registration-username', data.username, 6, 3600);
  const passwordHash = await hashPassword(data.password);
  const challenge = token(),
    code = String(randomInt(0, 1000000)).padStart(6, '0');
  const registration = await sql.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
    await capacity(tx);
    const used = await tx.unsafe(
      'SELECT user_id FROM member_credentials WHERE username=$1 UNION ALL SELECT id AS user_id FROM member_registrations WHERE username=$1 AND consumed_at IS NULL AND expires_at>now()',
      [data.username],
    );
    if (used.length)
      throw error('USERNAME_UNAVAILABLE', '该用户名不可用，请更换用户名', 409);
    // Existing email ownership is only disclosed after its code and original password are proven.
    const [row] = await tx.unsafe(
      "INSERT INTO member_registrations(username,email_key,password_hash,token_hash,expires_at,challenge_hash,code_hash,code_expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes',$5,$6,now()+interval '10 minutes') RETURNING id",
      [
        data.username,
        data.email,
        passwordHash,
        hash(token()),
        hash(challenge),
        codeDigest(challenge, code),
      ],
    );
    return row;
  });
  try {
    await deliverAccountMail({ to: data.email, purpose: 'CODE', raw: code });
  } catch (caught) {
    await sql.unsafe(
      'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
      [registration.id],
    );
    throw caught;
  }
  return {
    challenge,
    message:
      '验证码邮件已由邮件服务接受，请查看收件箱。实际收到后输入验证码完成注册。',
    expiresIn: 600,
  };
}
export async function resendRegistrationCode(
  challenge: string,
  password: string,
) {
  requireAccountMail();
  await authBudget('code-resend', hash(challenge), 3, 3600);
  const [row] = await sql.unsafe(
    'SELECT * FROM member_registrations WHERE challenge_hash=$1 AND consumed_at IS NULL AND expires_at>now()',
    [hash(challenge)],
  );
  if (!row || !(await verifyPassword(password, row.password_hash)))
    throw error('REGISTRATION_INVALID', '注册请求或密码无效，请重新注册');
  await authBudget('registration-email', row.email_key, 3, 3600);
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const changed = await sql.unsafe(
    "UPDATE member_registrations SET code_hash=$2,code_attempts=0,code_expires_at=now()+interval '10 minutes' WHERE id=$1 AND consumed_at IS NULL RETURNING id",
    [row.id, codeDigest(challenge, code)],
  );
  if (!changed.length)
    throw error('REGISTRATION_INVALID', '注册请求已失效，请重新注册');
  try {
    await deliverAccountMail({ to: row.email_key, purpose: 'CODE', raw: code });
  } catch (caught) {
    await sql.unsafe(
      'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
      [row.id],
    );
    throw caught;
  }
  return { message: '新的验证码邮件已由邮件服务接受，旧验证码已失效' };
}
export async function verifyRegistrationCode(
  challenge: string,
  code: string,
  password: string,
) {
  await authBudget('code-attempt', hash(challenge), 10, 900);
  const result = await sql.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
    const [row] = await tx.unsafe(
      'SELECT * FROM member_registrations WHERE challenge_hash=$1 FOR UPDATE',
      [hash(challenge)],
    );
    if (!row || row.consumed_at)
      return { failure: ['CODE_INVALID', '验证码无效或已使用'] };
    if (
      Math.min(
        new Date(row.code_expires_at).getTime(),
        new Date(row.expires_at).getTime(),
      ) <= Date.now()
    )
      return { failure: ['CODE_EXPIRED', '验证码已过期，请重新发送'] };
    if (row.code_attempts >= 5)
      return { failure: ['CODE_LOCKED', '验证码错误次数已达上限，请重新发送'] };
    await tx.unsafe(
      'UPDATE member_registrations SET code_attempts=code_attempts+1 WHERE id=$1',
      [row.id],
    );
    const digest = codeDigest(challenge, code);
    if (
      !row.code_hash ||
      !timingSafeEqual(
        Buffer.from(digest, 'hex'),
        Buffer.from(row.code_hash, 'hex'),
      ) ||
      !(await verifyPassword(password, row.password_hash))
    )
      return { failure: ['CODE_INVALID', '验证码或原注册密码不正确'] };
    const existing = await tx.unsafe(
      'SELECT id FROM users WHERE lower(email)=$1 UNION ALL SELECT user_id AS id FROM member_credentials WHERE email_key=$1',
      [row.email_key],
    );
    if (existing.length) {
      await tx.unsafe(
        'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
        [row.id],
      );
      return {
        failure: ['EMAIL_IN_USE', '此邮箱已注册，请直接登录或找回密码'],
      };
    }
    await capacity(tx);
    const used = await tx.unsafe(
      'SELECT user_id FROM member_credentials WHERE username=$1',
      [row.username],
    );
    if (used.length)
      return {
        failure: ['USERNAME_UNAVAILABLE', '该用户名不可用，请更换用户名'],
      };
    const [user] = await tx.unsafe(
      "INSERT INTO users(email,name,role) VALUES($1,$2,'Member') RETURNING *",
      [row.email_key, row.username],
    );
    await tx.unsafe(
      'INSERT INTO member_credentials(user_id,username,email_key,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
      [user.id, row.username, row.email_key, row.password_hash],
    );
    await tx.unsafe(
      'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
      [row.id],
    );
    await tx.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.email_verified')",
      [user.id],
    );
    await applyAutoGrant(user.id, tx);
    return {
      user: memberUser(user),
      passwordHash: row.password_hash as string,
    };
  });
  if (result.failure) throw error(result.failure[0], result.failure[1]);
  queueAccountMail(
    { to: result.user!.email, purpose: 'VERIFIED', ownerId: result.user!.id },
    async () => {},
  );
  return { user: result.user!, passwordHash: result.passwordHash! };
}
export async function changeMemberPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const next = await hashPassword(newPassword);
  const user = await sql.begin(async (tx) => {
    const [row] = await tx.unsafe(
      'SELECT c.*,u.role,u.disabled,u.deleted_at FROM users u JOIN member_credentials c ON c.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,c',
      [userId],
    );
    if (
      !row ||
      row.role === 'Owner' ||
      row.disabled ||
      row.deleted_at ||
      !(await verifyPassword(currentPassword, row.password_hash))
    )
      throw error('PASSWORD_INVALID', '当前密码不正确或账户不可用', 403);
    await tx.unsafe(
      'UPDATE member_credentials SET password_hash=$2,password_changed_at=now() WHERE user_id=$1',
      [userId, next],
    );
    await tx.unsafe('UPDATE sessions SET revoked_at=now() WHERE owner_id=$1', [
      userId,
    ]);
    await tx.unsafe(
      'UPDATE member_action_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [userId],
    );
    await tx.unsafe(
      'UPDATE member_google_links SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
      [userId],
    );
    await tx.unsafe(
      "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.password_changed')",
      [userId],
    );
    return row;
  });
  queueAccountMail(
    { to: user.email_key, purpose: 'PASSWORD_CHANGED', ownerId: userId },
    async () => {},
  );
}

export async function resumeCodeRegistration(email: string, password: string) {
  requireAccountMail();
  await authBudget('registration-email', email, 3, 3600);
  const [row] = await sql.unsafe(
    'SELECT * FROM member_registrations WHERE email_key=$1 AND code_hash IS NOT NULL AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1',
    [email],
  );
  if (!row || !(await verifyPassword(password, row.password_hash)))
    throw error(
      'REGISTRATION_INVALID',
      '没有可恢复的注册请求，或原注册密码不正确',
    );
  const challenge = token(),
    code = String(randomInt(0, 1000000)).padStart(6, '0');
  const changed = await sql.unsafe(
    "UPDATE member_registrations SET challenge_hash=$2,code_hash=$3,code_attempts=0,code_expires_at=now()+interval '10 minutes' WHERE id=$1 AND consumed_at IS NULL RETURNING id",
    [row.id, hash(challenge), codeDigest(challenge, code)],
  );
  if (!changed.length) throw error('REGISTRATION_INVALID', '注册请求已失效');
  try {
    await deliverAccountMail({ to: email, purpose: 'CODE', raw: code });
  } catch (caught) {
    await sql.unsafe(
      'UPDATE member_registrations SET consumed_at=now() WHERE id=$1',
      [row.id],
    );
    throw caught;
  }
  return {
    challenge,
    username: row.username,
    message: '新的验证码邮件已由邮件服务接受，旧验证码已失效',
  };
}

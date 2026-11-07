import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { AppError, type User } from '../../../packages/shared/src';
import { token, hash } from '../../../packages/shared/src/crypto';
import {
  registerMember,
  resendVerification,
  verifyRegistration,
  loginMember,
  requestPasswordReset,
  resetMemberPassword,
  createMemberGoogleLink,
  genericMailMessage,
  authBudget,
  memberUser,
} from '../../../packages/auth/src/member';
import {
  mailConfigured,
  settleAccountMail,
} from '../../../packages/auth/src/member-mail';

const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const password = z.string().min(1).max(512);
const actionToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/)
  .refine(
    (value) =>
      !['owner', 'admin', 'administrator', 'root', 'support'].includes(value),
    '用户名不可用',
  );
const limit = (max: number) => ({
  config: { rateLimit: { max, timeWindow: '15 minutes' } },
});
export async function registerMemberAuth(
  app: FastifyInstance,
  options: {
    origins: string[];
    setSession: (reply: FastifyReply, user: User) => Promise<unknown>;
    startGoogleLink: (reply: FastifyReply, id: string) => Promise<string>;
  },
) {
  const csrfCookie =
    process.env.NODE_ENV === 'production'
      ? '__Host-fafa_member_csrf'
      : 'fafa_member_csrf';
  const clearSession = (reply: FastifyReply) =>
    reply.clearCookie('fafa_session', {
      path: '/',
      ...(process.env.COOKIE_DOMAIN
        ? { domain: process.env.COOKIE_DOMAIN }
        : {}),
    });
  const guard = async (req: FastifyRequest) => {
    const value = req.headers['x-csrf-token'];
    const cookie = req.cookies[csrfCookie];
    if (
      !options.origins.includes(req.headers.origin || '') ||
      typeof value !== 'string' ||
      !cookie ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      !/^[A-Za-z0-9_-]{43}$/.test(cookie) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(cookie))
    )
      throw new AppError(403, 'CSRF', '安全验证失败，请刷新页面重试');
  };
  app.addHook('onClose', settleAccountMail);
  app.get('/auth/member/config', async (req, reply) => {
    if (
      (req.headers.origin && !options.origins.includes(req.headers.origin)) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new AppError(403, 'ORIGIN', '来源不允许');
    const csrf = token();
    reply.setCookie(csrfCookie, csrf, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
    });
    const [open] = await sql.unsafe(
      "SELECT value FROM settings WHERE key='member_registration_open'",
    );
    return {
      csrf,
      registrationOpen: open?.value === true,
      mailConfigured: mailConfigured(),
    };
  });
  app.post(
    '/auth/member/register',
    { ...limit(15), preHandler: guard },
    async (req, reply) => {
      const data = z
        .object({ username, email, password })
        .strict()
        .parse(req.body);
      await registerMember(data);
      return reply.code(202).send({ message: genericMailMessage });
    },
  );
  app.post(
    '/auth/member/resend-verification',
    { ...limit(10), preHandler: guard },
    async (req, reply) => {
      const data = z.object({ email, password }).strict().parse(req.body);
      await resendVerification(data.email, data.password);
      return reply.code(202).send({ message: genericMailMessage });
    },
  );
  app.post(
    '/auth/member/verify',
    { ...limit(15), preHandler: guard },
    async (req) => {
      const data = z
        .object({ token: actionToken, password })
        .strict()
        .parse(req.body);
      await authBudget('verify-token', hash(data.token), 5);
      await verifyRegistration(data.token, data.password);
      return { message: '邮箱已验证，账户已激活，请登录' };
    },
  );
  app.post(
    '/auth/member/login',
    { ...limit(30), preHandler: guard },
    async (req, reply) => {
      const data = z
        .object({
          identifier: z
            .string()
            .trim()
            .min(3)
            .max(254)
            .transform((value) => value.toLowerCase()),
          password,
        })
        .strict()
        .parse(req.body);
      const user = await loginMember(data.identifier, data.password);
      if (req.cookies.fafa_session)
        await sql.unsafe(
          'UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
          [hash(req.cookies.fafa_session)],
        );
      return options.setSession(reply, user);
    },
  );
  app.post(
    '/auth/member/forgot-password',
    { ...limit(15), preHandler: guard },
    async (req, reply) => {
      const data = z.object({ email }).strict().parse(req.body);
      await requestPasswordReset(data.email);
      return reply.code(202).send({ message: genericMailMessage });
    },
  );
  app.post(
    '/auth/member/reset-password',
    { ...limit(15), preHandler: guard },
    async (req, reply) => {
      const data = z
        .object({ token: actionToken, password })
        .strict()
        .parse(req.body);
      await authBudget('reset-token', hash(data.token), 5);
      await resetMemberPassword(data.token, data.password);
      clearSession(reply);
      return { message: '密码已重置，旧会话已撤销，请重新登录' };
    },
  );
  app.get('/api/member/profile', async (req) => {
    const [credential] = await sql.unsafe(
      'SELECT username,email_verified_at FROM member_credentials WHERE user_id=$1',
      [req.actor.id],
    );
    const identities = await sql.unsafe(
      'SELECT id FROM google_identities WHERE user_id=$1',
      [req.actor.id],
    );
    return {
      user: memberUser(req.actor),
      username: credential?.username || null,
      emailVerified: !!credential,
      passwordConfigured: !!credential,
      googleLinked: identities.length > 0,
      googleLinkAllowed: req.actor.role === 'Member' && !!credential,
    };
  });
  app.get('/api/member/sessions', async (req) => {
    const sessions = await sql.unsafe(
      'SELECT id,created_at,last_seen_at,expires_at FROM sessions WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
      [req.actor.id],
    );
    return sessions.map((session) => ({
      ...session,
      current: session.id === req.actor.session_id,
    }));
  });
  app.delete('/api/member/sessions/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const sessions = await sql.unsafe(
      'UPDATE sessions SET revoked_at=now() WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL RETURNING id',
      [id, req.actor.id],
    );
    if (!sessions.length)
      throw new AppError(404, 'NOT_FOUND', '会话不存在或无权操作');
    if (id === req.actor.session_id) clearSession(reply);
    await audit(req.actor.id, 'session.revoked', id);
    return { ok: true };
  });
  app.post('/api/member/google/start', limit(10), async (req, reply) => {
    if (req.actor.role !== 'Member')
      throw new AppError(
        403,
        'MEMBER_REQUIRED',
        '此入口仅用于普通密码账户绑定 Google，现有管理身份保持不变',
      );
    const data = z.object({ password }).strict().parse(req.body);
    const id = await createMemberGoogleLink(
      req.actor.id,
      req.actor.session_id,
      data.password,
    );
    return { url: await options.startGoogleLink(reply, id) };
  });
  app.get('/api/admin/member-registration', async () => {
    const settings = await sql.unsafe(
      "SELECT key,value FROM settings WHERE key IN ('member_registration_open','seat_limit')",
    );
    const [failures] = await sql.unsafe(
      "SELECT count(*)::int AS total FROM audit_events WHERE action='member.mail_failed' AND created_at>now()-interval '1 hour'",
    );
    return {
      enabled:
        settings.find((setting) => setting.key === 'member_registration_open')
          ?.value === true,
      seatLimit: Number(
        settings.find((setting) => setting.key === 'seat_limit')?.value || 20,
      ),
      mailConfigured: mailConfigured(),
      recentMailFailures: failures.total,
    };
  });
  app.patch('/api/admin/member-registration', async (req) => {
    if (req.actor.role !== 'Owner')
      throw new AppError(403, 'OWNER_REQUIRED', '仅 Owner 可修改自由注册策略');
    const data = z
      .object({
        enabled: z.boolean(),
        seatLimit: z.number().int().min(1).max(1000),
      })
      .strict()
      .parse(req.body);
    if (data.enabled && !mailConfigured())
      throw new AppError(
        503,
        'MAIL_UNCONFIGURED',
        '请先配置实际邮件服务，再开启自由注册',
      );
    await sql.begin(async (tx) => {
      await tx.unsafe('SELECT pg_advisory_xact_lock(77702)');
      await tx.unsafe(
        "UPDATE settings SET value=$1::jsonb,updated_at=now() WHERE key='member_registration_open'",
        [JSON.stringify(data.enabled)],
      );
      await tx.unsafe(
        "UPDATE settings SET value=$1::jsonb,updated_at=now() WHERE key='seat_limit'",
        [JSON.stringify(data.seatLimit)],
      );
      await tx.unsafe(
        "INSERT INTO audit_events(owner_id,action) VALUES($1,'member.registration_policy_updated')",
        [req.actor.id],
      );
    });
    return { ok: true };
  });
}

import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import { sql, audit, own, type ResourceTable } from '../../../packages/db/src';
import {
  AppError,
  notFound,
  isAdmin,
  writable,
  sourceSchema,
  aiSchema,
  serverSchema,
  locationSchema,
  type User,
} from '../../../packages/shared/src';
import { token, hash, seal, unseal } from '../../../packages/shared/src/crypto';
import {
  authenticate,
  createSession,
  mockEnabled,
  activateGoogle,
  google,
} from '../../../packages/auth/src';
import {
  parseSubscription,
  exportSubscription,
  deduplicate,
  type Node,
} from '../../../packages/subscription/src';
import {
  validateUrl,
  resolvePublic,
} from '../../../packages/subscription/src/network';
import { registerSsh } from './ssh';
import { registerAdmin } from './admin';
import { registerAi } from './ai';

declare module 'fastify' {
  interface FastifyRequest {
    actor: NonNullable<Awaited<ReturnType<typeof authenticate>>>;
  }
}
const params = (req: FastifyRequest) => req.params as Record<string, string>;
const schemas = {
  node_sources: sourceSchema,
  ai_accounts: aiSchema,
  server_connections: serverSchema,
  location_presets: locationSchema,
};
function publicRow(row: any) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ...row.data,
    credentialConfigured: !!row.secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function visibleNodes(owner: string) {
  const sources =
    await sql`select s.* from node_sources s where s.revoked_at is null and (s.owner_id=${owner} or exists(select 1 from node_group_grants g where g.source_id=s.id and g.user_id=${owner} and g.revoked_at is null))`;
  const active = sources.filter(
    (s) =>
      s.data.enabled &&
      !s.data.demo &&
      (!s.data.expiresAt || new Date(s.data.expiresAt) > new Date()),
  );
  if (!active.length) return [];
  const rows =
    await sql`select secret from nodes where source_id in ${sql(active.map((s) => s.id))} and revoked_at is null`;
  const [profile] =
    await sql`select data from subscription_profiles where owner_id=${owner} and revoked_at is null order by updated_at desc limit 1`;
  const country = profile?.data.country;
  const selected = country
    ? active.filter((s) => s.data.country === country)
    : active;
  const selectedRows = country
    ? selected.length
      ? await sql`select secret from nodes where source_id in ${sql(selected.map((s) => s.id))} and revoked_at is null`
      : []
    : rows;
  const [user] =
    await sql`select node_limit,subscription_enabled from users where id=${owner}`;
  return user?.subscription_enabled
    ? deduplicate(
        selectedRows.map((r) => JSON.parse(unseal(r.secret)) as Node),
      ).slice(0, user.node_limit)
    : [];
}
export async function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 1100000,
    requestIdHeader: false,
  });
  const origins = [
    process.env.WEB_ORIGIN || 'http://localhost:5173',
    process.env.ADMIN_ORIGIN || 'http://localhost:5174',
  ];
  await app.register(cookie);
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, {
    max: process.env.NODE_ENV === 'development' ? 3000 : 120,
    timeWindow: '1 minute',
  });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  app.setErrorHandler(async (e, _req, reply) => {
    const err = e as any;
    const status =
      err instanceof AppError
        ? err.status
        : err instanceof z.ZodError
          ? 400
          : err.statusCode && err.statusCode < 500
            ? err.statusCode
            : 500;
    if (status === 404 && _req.actor)
      await audit(_req.actor.id, 'access.denied', null, _req.id);
    reply.code(status).send({
      code:
        err instanceof AppError
          ? err.code
          : status === 400
            ? 'VALIDATION_ERROR'
            : status === 429
              ? 'RATE_LIMIT'
              : 'REQUEST_FAILED',
      message:
        err instanceof AppError
          ? err.message
          : status === 400
            ? '输入内容不符合要求'
            : status === 429
              ? '请求过于频繁，请稍后重试'
              : '请求未能完成，请检查配置后重试',
      correlationId: _req.id,
    });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .header('referrer-policy', 'no-referrer');
    if (!req.url.startsWith('/api/')) return;
    const actor = await authenticate(req.cookies.fafa_session);
    if (!actor) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    req.actor = actor;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (
        !origins.includes(req.headers.origin || '') ||
        req.headers['x-csrf-token'] !== actor.csrf
      )
        throw new AppError(403, 'CSRF', '安全验证失败，请刷新页面');
      if (
        (req.url.startsWith('/api/ai_accounts') ||
          req.url.startsWith('/api/server_connections') ||
          req.url === '/api/subscription/rotate') &&
        Date.now() - new Date(actor.reauthenticated_at).getTime() > 600000
      )
        throw new AppError(403, 'REAUTH_REQUIRED', '敏感操作需要重新登录');
      if (
        !writable(actor.role) &&
        !['/api/logout', '/api/data-request'].includes(req.url)
      )
        throw new AppError(403, 'READ_ONLY', '访客仅可查看');
    }
    if (req.url.startsWith('/api/admin/')) {
      if (!isAdmin(actor.role))
        throw new AppError(403, 'FORBIDDEN', '需要管理员权限');
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        Date.now() - new Date(actor.reauthenticated_at).getTime() > 10 * 60000
      )
        throw new AppError(403, 'REAUTH_REQUIRED', '敏感操作需要重新登录');
    }
  });
  app.get('/health', async () => ({
    status: 'ok',
    demo: process.env.DEMO_MODE === 'true',
  }));
  app.get('/ready', async () => {
    await sql`select 1`;
    return { status: 'ready' };
  });
  const setSession = async (reply: any, user: User) => {
    const s = await createSession(user);
    reply.setCookie('fafa_session', s.raw, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      ...(process.env.COOKIE_DOMAIN
        ? { domain: process.env.COOKIE_DOMAIN }
        : {}),
      path: '/',
      maxAge: 604800,
    });
    return { user, csrf: s.csrf, demo: process.env.DEMO_MODE === 'true' };
  };
  app.get('/auth/config', async () => ({
    mock: mockEnabled(),
    google: !!process.env.GOOGLE_CLIENT_ID,
    demo: process.env.DEMO_MODE === 'true',
  }));
  app.post(
    '/auth/dev',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!mockEnabled()) throw notFound();
      if (!origins.includes(req.headers.origin || ''))
        throw new AppError(403, 'ORIGIN', '来源不允许');
      const { profile } = z
        .object({ profile: z.enum(['owner', 'member', 'viewer']) })
        .parse(req.body);
      const ids = {
        owner: '11111111-1111-4111-8111-111111111111',
        member: '22222222-2222-4222-8222-222222222222',
        viewer: '33333333-3333-4333-8333-333333333333',
      };
      const [u] =
        await sql`select * from users where id=${ids[profile]} and not disabled`;
      if (!u) throw new AppError(403, 'DEV_SEED', '请先运行开发 seed');
      return setSession(reply, u as User);
    },
  );
  app.get('/auth/google', async (_req, reply) => {
    if (!process.env.GOOGLE_CLIENT_ID)
      throw new AppError(503, 'GOOGLE_UNCONFIGURED', 'Google 登录尚未配置');
    const state = token(),
      nonce = token(),
      verifier = token();
    const flow = { state, nonce, verifier, at: Date.now() };
    reply.setCookie(
      'fafa_oidc',
      Buffer.from(JSON.stringify(seal(JSON.stringify(flow)))).toString(
        'base64url',
      ),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/auth',
        maxAge: 600,
      },
    );
    return reply.redirect(
      google().generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        nonce,
        code_challenge: Buffer.from(hash(verifier), 'hex').toString(
          'base64url',
        ),
        code_challenge_method: 'S256' as any,
        prompt: 'select_account',
      }),
    );
  });
  app.get('/auth/google/callback', async (req, reply) => {
    const { state, code } = z
      .object({ state: z.string(), code: z.string() })
      .parse(req.query);
    let flow: any;
    try {
      flow = JSON.parse(
        unseal(
          JSON.parse(
            Buffer.from(req.cookies.fafa_oidc || '', 'base64url').toString(),
          ),
        ),
      );
    } catch {
      throw new AppError(403, 'OIDC_STATE', '登录验证已失效');
    }
    reply.clearCookie('fafa_oidc', { path: '/auth' });
    if (state !== flow.state || Date.now() - flow.at > 600000)
      throw new AppError(403, 'OIDC_STATE', '登录验证已失效');
    const client = google();
    const { tokens } = await client.getToken({
      code,
      codeVerifier: flow.verifier,
    });
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p || p.nonce !== flow.nonce)
      throw new AppError(403, 'OIDC_NONCE', '登录验证失败');
    const user = await activateGoogle(p);
    await setSession(reply, user);
    return reply.redirect(origins[0]);
  });
  app.get('/api/me', async (req) => ({
    user: {
      id: req.actor.id,
      name: req.actor.name,
      email: req.actor.email,
      role: req.actor.role,
      disabled: req.actor.disabled,
    },
    csrf: req.actor.csrf,
    demo: process.env.DEMO_MODE === 'true',
  }));
  app.post('/api/logout', async (req, reply) => {
    await sql`update sessions set revoked_at=now() where id=${req.actor.session_id}`;
    reply.clearCookie('fafa_session', { path: '/' });
    return { ok: true };
  });
  app.get(
    '/api/sessions',
    async (req) =>
      sql`select id,created_at,last_seen_at,expires_at from sessions where owner_id=${req.actor.id} and revoked_at is null`,
  );
  app.delete('/api/sessions/:id', async (req) => {
    await sql`update sessions set revoked_at=now() where id=${params(req).id} and owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'session.revoked', params(req).id);
    return { ok: true };
  });
  app.get('/api/summary', async (req) => {
    const [servers] =
      await sql`select count(*)::int as total from server_connections where owner_id=${req.actor.id} and revoked_at is null`;
    const [seats] =
      await sql`select count(*)::int as total from users where deleted_at is null`;
    const [limit] =
      await sql`select value from settings where key='seat_limit'`;
    return {
      nodes: (await visibleNodes(req.actor.id)).length,
      onlineNodes: null,
      servers: servers.total,
      seats: isAdmin(req.actor.role) ? seats.total : null,
      seatLimit: Number(limit.value),
      traffic: null,
    };
  });
  for (const table of Object.keys(schemas) as ResourceTable[]) {
    app.get(`/api/${table}`, async (req) =>
      (
        await sql`select * from ${sql(table)} where owner_id=${req.actor.id} and revoked_at is null order by created_at desc`
      ).map(publicRow),
    );
    app.get(`/api/${table}/:id`, async (req) => {
      const r = await own(table, z.uuid().parse(params(req).id), req.actor.id);
      if (!r) {
        await audit(req.actor.id, 'access.denied', params(req).id, req.id);
        throw notFound();
      }
      return publicRow(r);
    });
    const save = async (req: FastifyRequest) => {
      const data: any = schemas[table].parse(req.body);
      let secret: any = null;
      const id = (req.params as any)?.id;
      if (id && !(await own(table, z.uuid().parse(id), req.actor.id)))
        throw notFound();
      if (table === 'node_sources') {
        if (data.kind === 'REMOTE_SUBSCRIPTION') {
          if (!data.url)
            throw new AppError(400, 'SOURCE_URL', '请填写订阅链接');
          validateUrl(data.url);
          await resolvePublic(new URL(data.url).hostname);
          secret = seal(data.url);
        } else if (!data.content)
          throw new AppError(400, 'SOURCE_CONTENT', '请填写节点配置');
        data.nodeCount = 0;
        data.status = 'PENDING';
      }
      if (table === 'ai_accounts') {
        secret = seal(data.apiKey);
        data.status = 'UNVERIFIED';
        data.provider = 'OPENAI_API';
      }
      if (table === 'server_connections') {
        secret = seal(data.credential);
        data.status = 'UNKNOWN';
      }
      const content = data.content;
      let parsed: Node[] | null;
      try {
        parsed = content ? parseSubscription(content) : null;
      } catch {
        throw new AppError(
          400,
          'SUBSCRIPTION_PARSE',
          '节点配置格式无效或含有暂不支持的协议选项',
        );
      }
      delete data.apiKey;
      delete data.credential;
      delete data.url;
      delete data.content;
      let row;
      if (id) {
        [row] =
          await sql`update ${sql(table)} set data=${sql.json(data)},secret=${secret ? sql.json(secret) : null},updated_at=now() where id=${id} and owner_id=${req.actor.id} returning *`;
      } else {
        [row] =
          await sql`insert into ${sql(table)}(owner_id,data,secret) values(${req.actor.id},${sql.json(data)},${secret ? sql.json(secret) : null}) returning *`;
      }
      if (table === 'node_sources' && content) {
        const nodes = parsed!;
        await sql.begin(async (tx) => {
          await tx`update nodes set revoked_at=now() where source_id=${row.id} and revoked_at is null`;
          for (const node of nodes)
            await tx`insert into nodes(owner_id,source_id,data,secret) values(${req.actor.id},${row.id},${tx.json({ name: node.name, protocol: node.protocol, country: data.country })},${tx.json(seal(JSON.stringify(node)))})`;
          await tx`update node_sources set data=data || ${tx.json({ nodeCount: nodes.length, status: 'READY', lastSuccess: new Date().toISOString() })} where id=${row.id}`;
        });
      }
      await audit(
        req.actor.id,
        `${table}.${id ? 'updated' : 'created'}`,
        row.id,
        req.id,
      );
      return publicRow(row);
    };
    app.post(`/api/${table}`, save);
    app.put(`/api/${table}/:id`, save);
    app.delete(`/api/${table}/:id`, async (req) => {
      const id = z.uuid().parse(params(req).id);
      if (!(await own(table, id, req.actor.id))) throw notFound();
      await sql`update ${sql(table)} set revoked_at=now() where id=${id} and owner_id=${req.actor.id}`;
      await audit(req.actor.id, `${table}.deleted`, id, req.id);
      return { ok: true };
    });
  }
  app.patch('/api/node_sources/:id/enabled', async (req) => {
    const id = z.uuid().parse(params(req).id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    if (!(await own('node_sources', id, req.actor.id))) throw notFound();
    await sql`update node_sources set data=data || ${sql.json({ enabled })},updated_at=now() where id=${id} and owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'source.enabled_changed', id);
    return { ok: true };
  });
  app.post('/api/node_sources/:id/refresh', async (req) => {
    const r = await own(
      'node_sources',
      z.uuid().parse(params(req).id),
      req.actor.id,
    );
    if (!r) throw notFound();
    if (r.data.demo || r.data.kind !== 'REMOTE_SUBSCRIPTION')
      throw new AppError(400, 'REFRESH_UNAVAILABLE', '此源不支持远程刷新');
    const [job] =
      await sql`insert into background_jobs(owner_id,source_id,data) values(${req.actor.id},${r.id},${sql.json({ type: 'SUBSCRIPTION_SYNC', status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })}) returning id`;
    return job;
  });
  app.get('/api/subscription/profile', async (req) => {
    const [r] =
      await sql`select data from subscription_profiles where owner_id=${req.actor.id} and revoked_at is null order by updated_at desc limit 1`;
    return r?.data || { country: '' };
  });
  app.put('/api/subscription/profile', async (req) => {
    const { country } = z
      .object({ country: z.string().max(32) })
      .parse(req.body);
    await sql.begin(async (tx) => {
      await tx`update subscription_profiles set revoked_at=now() where owner_id=${req.actor.id} and revoked_at is null`;
      await tx`insert into subscription_profiles(owner_id,data) values(${req.actor.id},${tx.json({ country })})`;
    });
    await audit(req.actor.id, 'subscription.profile_updated');
    return { ok: true };
  });
  app.get('/api/shared-sources', async (req) =>
    (
      await sql`select s.* from node_sources s join node_group_grants g on g.source_id=s.id where g.user_id=${req.actor.id} and g.revoked_at is null and s.revoked_at is null`
    ).map((r) => ({ ...publicRow(r), shared: true })),
  );
  app.get(
    '/api/sync-runs',
    async (req) =>
      sql`select id,data,created_at from subscription_sync_runs where owner_id=${req.actor.id} order by created_at desc limit 50`,
  );
  app.post('/api/subscription/rotate', async (req) => {
    const raw = token();
    await sql.begin(async (tx) => {
      await tx`update subscription_tokens set revoked_at=now() where owner_id=${req.actor.id} and revoked_at is null`;
      await tx`insert into subscription_tokens(owner_id,token_hash,data) values(${req.actor.id},${hash(raw)},${tx.json({ enabled: true })})`;
    });
    await audit(req.actor.id, 'subscription.rotated', null, req.id);
    return {
      url: `${process.env.API_PUBLIC_URL || 'http://localhost:4000'}/subscription/${raw}`,
      notice: '此链接仅显示一次，请妥善保存',
    };
  });
  app.delete('/api/subscription', async (req) => {
    await sql`update subscription_tokens set revoked_at=now() where owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'subscription.revoked');
    return { ok: true };
  });
  app.get(
    '/subscription/:token',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const raw = params(req).token;
      const [t] =
        await sql`select t.* from subscription_tokens t join users u on u.id=t.owner_id where t.token_hash=${hash(raw)} and t.revoked_at is null and not u.disabled and u.deleted_at is null and u.subscription_enabled and t.data->>'enabled'='true'`;
      if (!t) throw notFound();
      const { format } = z
        .object({
          format: z
            .enum(['mihomo', 'sing-box', 'uri', 'base64'])
            .default('mihomo'),
        })
        .parse(req.query);
      const nodes = await visibleNodes(t.owner_id);
      reply.type(
        format === 'sing-box'
          ? 'application/json'
          : format === 'mihomo'
            ? 'text/yaml'
            : 'text/plain',
      );
      return exportSubscription(nodes, format);
    },
  );
  app.get('/api/data-export', async (req) => {
    const result: Record<string, unknown> = {
      user: {
        id: req.actor.id,
        name: req.actor.name,
        email: req.actor.email,
        role: req.actor.role,
      },
    };
    for (const table of Object.keys(schemas))
      result[table] = (
        await sql`select * from ${sql(table)} where owner_id=${req.actor.id} and revoked_at is null`
      ).map(publicRow);
    return result;
  });
  app.post('/api/data-request', async (req) => {
    await audit(req.actor.id, 'data.deletion_requested');
    return { message: '删除请求已登记，请联系管理员核验并处理' };
  });
  await registerAdmin(app);
  await registerAi(app);
  await registerSsh(app, origins);
  return app;
}

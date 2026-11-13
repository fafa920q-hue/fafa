import { platformAccountsEnabled } from '../../../packages/auth/src/platform-gpt';
import type { ISql } from 'postgres';
import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import {
  activeGrant,
  resolveAccess,
  sourceAllowed,
  withinNodeGrantScope,
} from '../../../packages/auth/src/business-access';
import { registerAccessCenter } from './access-center';
import { assertServiceOpen } from '../../../packages/auth/src/service-policy';
import type { TokenPayload } from 'google-auth-library';
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
  aiProviderSchema,
  anthropicApiEnabled,
  serverSchema,
  locationSchema,
  type User,
} from '../../../packages/shared/src';
import { token, hash, seal, unseal } from '../../../packages/shared/src/crypto';
import { toNotification } from '../../../packages/shared/src/notifications';
import {
  nodeInSubscriptionContent,
  nodeStateFlagsOf,
} from '../../../packages/shared/src/admin-nodes';
import {
  SUBSCRIPTION_DOWNLOAD_FORMATS,
  normalizeSubscriptionFormat,
} from '../../../packages/shared/src/subscription-format';
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
  nodeMetadata,
} from '../../../packages/subscription/src';
import {
  validateUrl,
  resolvePublic,
} from '../../../packages/subscription/src/network';
import { registerLocationTools } from './location-tools';
import { registerNodes } from './nodes';
import { registerWorkspace } from './workspace';
import { registerSsh } from './ssh';
import { registerAdmin } from './admin';
import { registerAi } from './ai';
import { registerPlatformAi } from './platform-ai';
import { registerPlatformChat } from './platform-chat';
import {
  beginOwnerCredential,
  completeOwnerCredential,
  ownerSetupAvailable,
} from '../../../packages/auth/src/owner';
import { publicOrigin } from '../../../packages/auth/src/urls';
import { completeMemberGoogleLink } from '../../../packages/auth/src/member';
import { registerMemberAuth } from './member-auth';

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
    credentialConfigured: !!(row.secret ?? row.anthropic_secret),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function authorizedNodeRows(
  user: Awaited<ReturnType<typeof resolveAccess>>,
  db: ISql,
) {
  const owner = user.id;
  const rows =
    await db`select n.*,s.data as source_data,s.owner_id as source_owner,u.role as source_role,g.data as grant_data from nodes n join node_sources s on s.id=n.source_id join users u on u.id=s.owner_id left join node_group_grants g on g.source_id=s.id and g.user_id=${owner} and g.revoked_at is null where n.revoked_at is null and s.revoked_at is null and not u.disabled and u.deleted_at is null and (s.owner_id=${owner} or g.id is not null or (u.role in ('Owner','Admin') and s.id=any(${user._access.subscriptionSources as string[]}::uuid[])))`;
  return rows.filter(
    (row) =>
      sourceAllowed(
        user,
        row.source_id,
        row.data.group || row.source_data.group || '',
      ) &&
      withinNodeGrantScope(
        row.grant_data,
        row.id,
        row.data.group || row.source_data.group || '',
      ) &&
      ((user._access.base.node && row.source_owner === owner) ||
        ((row.source_data.kind === 'OWNED_NODE' ||
          (row.source_data.authorized === true &&
            row.source_data.redistributionAuthorized === true &&
            row.source_data.authorizationReference?.trim())) &&
          ((user._access.base.node &&
            row.grant_data &&
            activeGrant(row.grant_data)) ||
            (['Owner', 'Admin'].includes(row.source_role) &&
              user._access.subscriptionSources.includes(row.source_id))))) &&
      row.source_data.enabled &&
      !row.source_data.demo &&
      row.data.enabled !== false &&
      (!row.source_data.expiresAt ||
        new Date(row.source_data.expiresAt) > new Date()),
  );
}
export async function visibleNodes(owner: string) {
  const [rawUser] =
    await sql`select * from users where id=${owner} and not disabled and deleted_at is null`;
  const user = rawUser ? await resolveAccess(rawUser) : null;
  if (!user?.subscription_enabled || !capabilityAllowed(user, 'node'))
    return [];
  const [profile] =
    await sql`select data from subscription_profiles where owner_id=${owner} and revoked_at is null order by updated_at desc limit 1`;
  const filter = profile?.data || {};
  const nodes = (await authorizedNodeRows(user, sql))
    .filter(
      (row) =>
        nodeInSubscriptionContent(nodeStateFlagsOf(row.source_data)) &&
        (!filter.country ||
          (row.data.country || row.source_data.country) === filter.country) &&
        (!filter.protocol || row.data.protocol === filter.protocol) &&
        (!Array.isArray(filter.nodeIds) ||
          !filter.nodeIds.length ||
          filter.nodeIds.includes(row.id)) &&
        (!filter.group ||
          (row.data.group || row.source_data.group || row.source_data.kind) ===
            filter.group),
    )
    .map(
      (row) =>
        ({
          ...JSON.parse(unseal(row.secret)),
          name: row.data.name,
          country: row.data.country,
          tags: row.data.tags,
          aliases: row.data.aliases,
        }) as Node,
    );
  return deduplicate(nodes).slice(0, user.node_limit);
}
function sharedCookieDomain() {
  return process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {};
}
function visiblePersonalAccount(
  table: string,
  role: Parameters<typeof isAdmin>[0],
  provider: unknown,
) {
  return (
    table !== 'ai_accounts' ||
    !platformAccountsEnabled() ||
    isAdmin(role) ||
    provider === 'ANTHROPIC_API'
  );
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
  await app.register(cors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, {
    ...(process.env.NODE_ENV === 'development' && process.env.API_PREVIEW_SOCKET
      ? { keyGenerator: (req: FastifyRequest) => req.ip ?? 'private-preview' }
      : {}),
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
      // 400 仍保留原 message 与 code（不影响已有客户端），同时附上字段级
      // issues（path/code/message），前端可逐条展示具体是哪个字段不符合
      // 要求，而不是只有一句笼统提示。
      ...(err instanceof z.ZodError
        ? {
            issues: err.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
              message: issue.message,
            })),
          }
        : {}),
    });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .header('referrer-policy', 'no-referrer');
    // Public download tokens have their own authentication. Exempt only exact GET/HEAD routes.
    const path = req.url.split('?')[0];
    if (
      ['GET', 'HEAD'].includes(req.method) &&
      (['/api/health', '/api/ready'].includes(path) ||
        /^\/api\/subscription\/download\/[^/]+$/.test(path))
    )
      return;
    if (!path.startsWith('/api/')) return;
    const identity = await authenticate(req.cookies.fafa_session);
    if (!identity) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const actor = await resolveAccess(identity);
    req.actor = actor;
    if (
      platformAccountsEnabled() &&
      !isAdmin(actor.role) &&
      /^\/api\/ai_accounts(\/|$)/.test(path)
    )
      throw new AppError(403, 'AI_PLATFORM_ONLY', '请使用平台 AI 服务');
    const capability = /^\/api\/(servers|server_connections)(\/|$)/.test(path)
      ? 'server'
      : /^\/api\/(ai|ai_accounts)(\/|$)/.test(path)
        ? 'codex'
        : /^\/api\/(subscription|node_sources|nodes|node-import|shared-sources)(\/|$)/.test(
              path,
            )
          ? 'node'
          : undefined;
    if (
      capability ||
      /^\/api\/(location-tools|location_presets)(\/|$)/.test(path)
    )
      await assertServiceOpen(actor);
    if (capability && !capabilityAllowed(actor, capability))
      throw new AppError(
        403,
        'CAPABILITY_REQUIRED',
        '此功能尚未授权或试用已到期，请联系管理员',
      );
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (
        !origins.includes(req.headers.origin || '') ||
        req.headers['x-csrf-token'] !== actor.csrf
      )
        throw new AppError(403, 'CSRF', '安全验证失败，请刷新页面');
      if (
        /^\/api\/(node-import|node_sources|nodes)(\/|$)/.test(path) &&
        !isAdmin(actor.role)
      )
        throw new AppError(
          403,
          'ADMIN_NODE_MANAGEMENT',
          '节点由管理员统一添加和管理',
        );
      if (
        (req.url.startsWith('/api/node-import') ||
          req.url.startsWith('/api/node_sources') ||
          req.url.startsWith('/api/nodes') ||
          req.url.startsWith('/api/ai_accounts') ||
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
  app.get('/api/health', async () => ({
    status: 'ok',
    demo: process.env.DEMO_MODE === 'true',
  }));
  app.get('/api/ready', async () => {
    await sql`select 1`;
    return { status: 'ready' };
  });
  app.get('/health', async () => ({
    status: 'ok',
    demo: process.env.DEMO_MODE === 'true',
  }));
  app.get('/ready', async () => {
    await sql`select 1`;
    return { status: 'ready' };
  });
  const setSession = async (
    reply: any,
    user: User,
    expectedPasswordHash?: string,
    remember = true,
  ) => {
    const s = await createSession(user, expectedPasswordHash);
    reply.setCookie('fafa_session', s.raw, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      ...sharedCookieDomain(),
      path: '/',
      ...(remember ? { maxAge: 604800 } : {}),
    });
    return { user, csrf: s.csrf, demo: process.env.DEMO_MODE === 'true' };
  };
  app.get('/auth/config', async () => ({
    mock: mockEnabled(),
    google: !!process.env.GOOGLE_CLIENT_ID,
    ownerSetup: await ownerSetupAvailable(),
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
  // Google 登录来源与绑定一并保留：普通登录按 app 回前台/后台，
  // Member 绑定按 memberLink 回 /member/account，Owner 初始化按
  // ownerCredential 走原流程；三者不得互相冒充（整合 PR #4 + PR #2）。
  type GoogleStartOptions = {
    app?: 'web' | 'admin';
    ownerCredential?: string;
    memberLink?: string;
  };
  const startGoogle = async (reply: any, options: GoogleStartOptions = {}) => {
    if (!process.env.GOOGLE_CLIENT_ID)
      throw new AppError(503, 'GOOGLE_UNCONFIGURED', 'Google 登录尚未配置');
    const state = token(),
      nonce = token(),
      verifier = token();
    const ownerCredential = options.ownerCredential
      ? await beginOwnerCredential(options.ownerCredential, state)
      : undefined;
    const flow = {
      state,
      nonce,
      verifier,
      at: Date.now(),
      ownerCredential,
      app: options.app ?? 'web',
      memberLink: options.memberLink,
    };
    reply.setCookie(
      'fafa_oidc',
      Buffer.from(JSON.stringify(seal(JSON.stringify(flow)))).toString(
        'base64url',
      ),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        ...sharedCookieDomain(),
        path: '/auth',
        maxAge: 600,
      },
    );
    return google().generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      code_challenge: Buffer.from(hash(verifier), 'hex').toString('base64url'),
      code_challenge_method: 'S256' as any,
      prompt: 'select_account',
    });
  };
  app.get('/auth/google', async (req, reply) => {
    const { app } = z
      .object({ app: z.enum(['web', 'admin']).optional() })
      .parse(req.query);
    return reply.redirect(await startGoogle(reply, { app: app ?? 'web' }));
  });
  app.post(
    '/auth/owner/start',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!(await ownerSetupAvailable())) throw notFound();
      if (!origins.includes(req.headers.origin || ''))
        throw new AppError(403, 'ORIGIN', '来源不允许');
      const { credential, app } = z
        .object({
          credential: z.string().min(70).max(100),
          app: z.enum(['web', 'admin']).optional(),
        })
        .parse(req.body);
      return {
        url: await startGoogle(reply, {
          ownerCredential: credential,
          app: app ?? 'web',
        }),
      };
    },
  );
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
    reply.clearCookie('fafa_oidc', { path: '/auth', ...sharedCookieDomain() });
    if (state !== flow.state || Date.now() - flow.at > 600000)
      throw new AppError(403, 'OIDC_STATE', '登录验证已失效');
    const client = google();
    let p: TokenPayload | undefined;
    try {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: flow.verifier,
      });
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token!,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      p = ticket.getPayload();
    } catch {
      throw new AppError(403, 'OIDC_TOKEN', 'Google 身份验证失败，请重新登录');
    }
    if (
      !p ||
      !p.sub ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss) ||
      p.aud !== process.env.GOOGLE_CLIENT_ID ||
      !p.exp ||
      p.exp <= Math.floor(Date.now() / 1000) ||
      p.nonce !== flow.nonce
    )
      throw new AppError(403, 'OIDC_NONCE', '登录验证失败');
    const user = flow.memberLink
      ? await completeMemberGoogleLink(
          flow.memberLink,
          hash(req.cookies.fafa_session || ''),
          p,
        )
      : flow.ownerCredential
        ? await completeOwnerCredential(flow.ownerCredential, flow.state, p)
        : await activateGoogle(p);
    await setSession(reply, user);
    if (flow.memberLink) return reply.redirect(origins[0] + '/member/account');
    return reply.redirect(flow.app === 'admin' ? origins[1] : origins[0]);
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
  // Stage D: user notifications = owner-scoped audit trail, no demo data.
  app.get('/api/notifications', async (req) => {
    const rows = await sql<
      {
        id: string;
        action: string;
        target_id: string | null;
        correlation_id: string | null;
        created_at: string;
      }[]
    >`select id, action, target_id, correlation_id, created_at from audit_events where owner_id = ${req.actor.id} order by created_at desc limit 50`;
    return rows.map((row) => toNotification(row));
  });
  app.post('/api/logout', async (req, reply) => {
    await sql`update sessions set revoked_at=now() where id=${req.actor.session_id}`;
    reply.clearCookie('fafa_session', { path: '/', ...sharedCookieDomain() });
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
      )
        .filter((row) =>
          visiblePersonalAccount(table, req.actor.role, row.data.provider),
        )
        .map(publicRow),
    );
    app.get(`/api/${table}/:id`, async (req) => {
      const r = await own(table, z.uuid().parse(params(req).id), req.actor.id);
      if (!r) {
        await audit(req.actor.id, 'access.denied', params(req).id, req.id);
        throw notFound();
      }
      if (!visiblePersonalAccount(table, req.actor.role, r.data.provider))
        throw notFound();
      return publicRow(r);
    });
    const save = async (req: FastifyRequest) => {
      const data: any = schemas[table].parse(req.body);
      if (
        table === 'node_sources' &&
        data.kind === 'THIRD_PARTY_NODE' &&
        (!isAdmin(req.actor.role) ||
          !data.redistributionAuthorized ||
          !data.authorizationReference.trim())
      )
        throw new AppError(
          403,
          'REDISTRIBUTION_REQUIRED',
          '第三方节点需要管理员权限与再分发授权',
        );
      let secret: any = null;
      const id = (req.params as any)?.id;
      const existing = id
        ? await own(table, z.uuid().parse(id), req.actor.id)
        : null;
      if (id && !existing) throw notFound();
      if (table === 'node_sources') {
        if (data.kind === 'REMOTE_SUBSCRIPTION') {
          if (data.content)
            throw new AppError(
              400,
              'SOURCE_FORMAT',
              '订阅源不能同时提交节点内容',
            );
          if (!data.url)
            throw new AppError(400, 'SOURCE_URL', '请填写订阅链接');
          validateUrl(data.url);
          await resolvePublic(new URL(data.url).hostname);
          secret = seal(data.url);
        } else if (!data.content)
          throw new AppError(400, 'SOURCE_CONTENT', '请填写节点配置');
        data.nodeCount = existing?.data.nodeCount || 0;
        data.status = 'PENDING';
        data.error = null;
        data.lastSuccess = existing?.data.lastSuccess || null;
        data.syncRevision = token();
      }
      if (table === 'ai_accounts') {
        const provider = aiProviderSchema.parse(
          existing
            ? (existing.data.provider ?? 'OPENAI_API')
            : (data.provider ?? 'OPENAI_API'),
        );
        if (!visiblePersonalAccount(table, req.actor.role, provider))
          throw new AppError(403, 'AI_PLATFORM_ONLY', '请使用平台 AI 服务');
        if (data.provider && data.provider !== provider)
          throw new AppError(
            400,
            'AI_PROVIDER_MISMATCH',
            '现有账户不能更换提供商',
          );
        if (provider === 'ANTHROPIC_API' && !anthropicApiEnabled())
          throw new AppError(503, 'CLAUDE_API_DISABLED', 'Claude API 暂未开放');
        secret = seal(data.apiKey);
        data.status = 'UNVERIFIED';
        data.provider = provider;
        data.selected = existing?.data.selected === true;
      }
      if (table === 'server_connections') {
        secret = seal(data.credential);
        data.status = 'UNKNOWN';
      }
      const anthropicSecret =
        table === 'ai_accounts' && data.provider === 'ANTHROPIC_API'
          ? secret
          : null;
      if (anthropicSecret) secret = null;
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
      const row = await sql.begin(async (tx) => {
        if (id) {
          const [locked] =
            await tx`select id from ${tx(table)} where id=${id} and owner_id=${req.actor.id} and revoked_at is null for update`;
          if (!locked) throw notFound();
        }
        let row;
        if (id) {
          [row] =
            await tx`update ${tx(table)} set data=${tx.json(data)},secret=${secret ? tx.json(secret) : null},updated_at=now() where id=${id} and owner_id=${req.actor.id} returning *`;
        } else {
          [row] =
            await tx`insert into ${tx(table)}(owner_id,data,secret) values(${req.actor.id},${tx.json(data)},${secret ? tx.json(secret) : null}) returning *`;
        }
        if (anthropicSecret) {
          [row] =
            await tx`update ai_accounts set anthropic_secret=${tx.json(anthropicSecret)} where id=${row.id} and owner_id=${req.actor.id} returning *`;
        }
        if (table === 'node_sources') {
          await tx`update background_jobs set data=data || '{"status":"CANCELLED"}'::jsonb,updated_at=now() where source_id=${row.id} and data->>'status' in ('QUEUED','RUNNING')`;
          if (content) {
            const nodes = parsed!;
            await tx`update nodes set revoked_at=now() where source_id=${row.id} and revoked_at is null`;
            for (const node of nodes)
              await tx`insert into nodes(owner_id,source_id,data,secret) values(${req.actor.id},${row.id},${tx.json({ ...nodeMetadata(node, data.country), group: data.group || '' })},${tx.json(seal(JSON.stringify(node)))})`;
            [row] =
              await tx`update node_sources set data=data || ${tx.json({ nodeCount: nodes.length, status: 'READY', lastSuccess: new Date().toISOString() })} where id=${row.id} returning *`;
          } else if (data.kind === 'REMOTE_SUBSCRIPTION' && data.enabled) {
            await tx`insert into background_jobs(owner_id,source_id,data) values(${req.actor.id},${row.id},${tx.json({ type: 'SUBSCRIPTION_SYNC', status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })})`;
            await tx`update node_sources set data=data || ${tx.json({ lastScheduled: new Date().toISOString() })} where id=${row.id}`;
          }
        }
        return row;
      });
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
      await sql.begin(async (tx) => {
        const [row] =
          await tx`select id,data from ${tx(table)} where id=${id} and owner_id=${req.actor.id} and revoked_at is null for update`;
        if (
          !row ||
          !visiblePersonalAccount(table, req.actor.role, row.data.provider)
        )
          throw notFound();
        await tx`update ${tx(table)} set revoked_at=now() where id=${id} and owner_id=${req.actor.id}`;
        if (table === 'node_sources')
          await tx`update background_jobs set data=data || '{"status":"CANCELLED"}'::jsonb,updated_at=now() where source_id=${id} and data->>'status' in ('QUEUED','RUNNING')`;
      });
      await audit(req.actor.id, `${table}.deleted`, id, req.id);
      return { ok: true };
    });
  }
  app.patch('/api/node_sources/:id', async (req) => {
    const id = z.uuid().parse(params(req).id);
    const changes = z
      .object({
        name: z.string().min(1).max(80).optional(),
        group: z.string().max(80).optional(),
        country: z.string().max(32).optional(),
        provider: z.string().max(80).optional(),
        enabled: z.boolean().optional(),
        expiresAt: z.iso.datetime().nullable().optional(),
        authorized: z.literal(true).optional(),
        redistributionAuthorized: z.boolean().optional(),
        authorizationReference: z.string().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    const row = await sql.begin(async (tx) => {
      const [source] =
        await tx`select * from node_sources where id=${id} and owner_id=${req.actor.id} and revoked_at is null for update`;
      if (!source) throw notFound();
      const data = { ...source.data, ...changes };
      if (
        data.kind === 'THIRD_PARTY_NODE' &&
        data.redistributionAuthorized &&
        (!isAdmin(req.actor.role) ||
          !data.authorized ||
          !data.authorizationReference?.trim())
      )
        throw new AppError(
          403,
          'REDISTRIBUTION_REQUIRED',
          '第三方节点需要管理员权限与再分发授权',
        );
      if (changes.group !== undefined)
        await tx`update nodes set data=data || ${tx.json({ group: changes.group })},updated_at=now() where source_id=${id} and revoked_at is null and not (coalesce(data->'overrides','{}'::jsonb) ? 'group')`;
      const [updated] =
        await tx`update node_sources set data=${tx.json(data)},updated_at=now() where id=${id} returning *`;
      return updated;
    });
    await audit(req.actor.id, 'source.metadata_updated', id, req.id);
    return publicRow(row);
  });
  app.patch('/api/node_sources/:id/enabled', async (req) => {
    const id = z.uuid().parse(params(req).id);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    if (!(await own('node_sources', id, req.actor.id))) throw notFound();
    await sql`update node_sources set data=data || ${sql.json({ enabled })},updated_at=now() where id=${id} and owner_id=${req.actor.id} and revoked_at is null`;
    await audit(req.actor.id, 'source.enabled_changed', id);
    return { ok: true };
  });
  app.post('/api/node_sources/:id/refresh', async (req) => {
    const id = z.uuid().parse(params(req).id);
    return sql.begin(async (tx) => {
      const [r] =
        await tx`select * from node_sources where id=${id} and owner_id=${req.actor.id} and revoked_at is null for update`;
      if (!r) throw notFound();
      if (
        r.data.demo ||
        !r.data.enabled ||
        r.data.kind !== 'REMOTE_SUBSCRIPTION'
      )
        throw new AppError(
          400,
          'REFRESH_UNAVAILABLE',
          '此源未启用或不支持远程刷新',
        );
      const [existing] =
        await tx`select id from background_jobs where source_id=${id} and data->>'status' in ('QUEUED','RUNNING') and revoked_at is null order by created_at limit 1`;
      if (existing) return { id: existing.id, queued: true };
      const [job] =
        await tx`insert into background_jobs(owner_id,source_id,data) values(${req.actor.id},${r.id},${tx.json({ type: 'SUBSCRIPTION_SYNC', status: 'QUEUED', attempt: 0, nextRun: new Date().toISOString() })}) returning id`;
      await tx`update node_sources set data=data || ${tx.json({ lastScheduled: new Date().toISOString() })} where id=${id}`;
      return { id: job.id, queued: true };
    });
  });
  app.get('/api/subscription/profile', async (req) => {
    const [r] =
      await sql`select data from subscription_profiles where owner_id=${req.actor.id} and revoked_at is null order by updated_at desc limit 1`;
    return r?.data || { country: '' };
  });
  app.put('/api/subscription/profile', async (req) => {
    const profile = z
      .object({
        country: z.string().max(32).default(''),
        protocol: z
          .enum(['', 'ss', 'vmess', 'vless', 'trojan', 'hysteria2'])
          .default(''),
        group: z.string().max(80).default(''),
        nodeIds: z.array(z.uuid()).max(5000).optional(),
      })
      .parse(req.body);
    await sql.begin(async (tx) => {
      await tx`update subscription_profiles set revoked_at=now() where owner_id=${req.actor.id} and revoked_at is null`;
      await tx`insert into subscription_profiles(owner_id,data) values(${req.actor.id},${tx.json(profile)})`;
    });
    await audit(req.actor.id, 'subscription.profile_updated');
    return { ok: true };
  });
  app.get('/api/shared-sources', async (req) =>
    (
      await sql`select s.* from node_sources s join node_group_grants g on g.source_id=s.id join users u on u.id=s.owner_id where g.user_id=${req.actor.id} and g.revoked_at is null and (not (g.data ? 'expiresAt') or (g.data->>'expiresAt')::timestamptz>now()) and s.revoked_at is null and not u.disabled and u.deleted_at is null and (s.data->>'kind'='OWNED_NODE' or (s.data->>'authorized'='true' and s.data->>'redistributionAuthorized'='true' and length(trim(coalesce(s.data->>'authorizationReference','')))>0))`
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
      const [identity] =
        await tx`SELECT * FROM users WHERE id=${req.actor.id} FOR UPDATE`;
      const user = identity ? await resolveAccess(identity, tx) : null;
      if (
        !user ||
        !user.subscription_enabled ||
        !capabilityAllowed(user, 'node')
      )
        throw new AppError(
          403,
          'CAPABILITY_REQUIRED',
          '订阅权限尚未开放或已到期',
        );
      await assertServiceOpen(user, tx);
      if (
        Number(user.node_limit) < 1 ||
        !(await authorizedNodeRows(user, tx)).filter((row) =>
          nodeInSubscriptionContent(nodeStateFlagsOf(row.source_data)),
        ).length
      )
        throw new AppError(
          403,
          'NO_SUBSCRIPTION_NODES',
          '尚无已授权的可订阅节点',
        );
      await tx`update subscription_tokens set revoked_at=now() where owner_id=${req.actor.id} and revoked_at is null`;
      await tx`insert into subscription_tokens(owner_id,token_hash,data) values(${req.actor.id},${hash(raw)},${tx.json({ enabled: true })})`;
    });
    await audit(req.actor.id, 'subscription.rotated', null, req.id);
    return {
      url: `${publicOrigin()}/api/subscription/download/${raw}`,
      notice: '此链接仅显示一次，请妥善保存',
    };
  });
  app.delete('/api/subscription', async (req) => {
    await sql`update subscription_tokens set revoked_at=now() where owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'subscription.revoked');
    return { ok: true };
  });
  // Keep existing tokens and legacy URLs valid without redirecting secret URLs.
  for (const path of [
    '/api/subscription/download/:token',
    '/subscription/:token',
  ])
    app.get(
      path,
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const raw = params(req).token;
        const [t] =
          await sql`select t.*,u.role,u.node_access_enabled,u.node_access_until from subscription_tokens t join users u on u.id=t.owner_id where t.token_hash=${hash(raw)} and t.revoked_at is null and not u.disabled and u.deleted_at is null and u.subscription_enabled and t.data->>'enabled'='true'`;
        if (!t) throw notFound();
        const [rawUser] =
          await sql`SELECT * FROM users WHERE id=${t.owner_id} AND NOT disabled AND deleted_at IS NULL`;
        const user = rawUser ? await resolveAccess(rawUser) : null;
        if (
          !user ||
          !user.subscription_enabled ||
          !capabilityAllowed(user, 'node') ||
          !activeGrant({ expiresAt: t.data.expiresAt })
        )
          throw new AppError(
            403,
            'CAPABILITY_REQUIRED',
            '订阅授权已撤销或到期',
          );
        await assertServiceOpen(user);
        const { format: rawFormat } = z
          .object({
            format: z.enum(SUBSCRIPTION_DOWNLOAD_FORMATS).default('mihomo'),
          })
          .parse(req.query);
        // `clash` 是 `mihomo`（Mihomo/Clash YAML）的別名；`shadowrocket` 與
        // `v2rayn` 對映到既有的 `uri` 與 `base64` 匯出格式（見
        // packages/shared/src/subscription-format.ts）。
        const format = normalizeSubscriptionFormat(rawFormat);
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
  await registerMemberAuth(app, {
    origins,
    setSession,
    startGoogleLink: (reply, id) => startGoogle(reply, { memberLink: id }),
  });
  await registerLocationTools(app);
  await registerNodes(app);
  await registerWorkspace(app);
  await registerAdmin(app);
  await registerAccessCenter(app);
  await registerAi(app, origins);
  await registerPlatformAi(app);
  await registerPlatformChat(app);
  await registerSsh(app, origins);
  return app;
}

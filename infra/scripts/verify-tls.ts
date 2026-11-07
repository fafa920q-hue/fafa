import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import {
  createTlsDiagnostics,
  corsHeaders,
  errorCategory,
} from './tls-diagnostics';
const temporary = await mkdtemp(join(tmpdir(), 'fafa-tls-'));
const container = 'fafa-tls-test-' + randomUUID().slice(0, 8);
const domains = ['fafa888.uk', 'a.fafa888.uk'];
const port = 443;
const network = process.env.FAFA_COMPOSE_NETWORK || 'fafa-one-dev_default';
let created = false;

let networkEvents = 0;
let lastNetworkEvent = Date.now();
let monitorFailed = false;
const networkMonitor = spawn('ip', ['monitor', 'link', 'address', 'route'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
networkMonitor.stdout.on('data', (chunk: Buffer) => {
  networkEvents += chunk.toString().split('\n').filter(Boolean).length;
  lastNetworkEvent = Date.now();
});
networkMonitor.on('error', () => {
  monitorFailed = true;
});
networkMonitor.on('exit', () => {
  monitorFailed = true;
});
async function waitForNetworkQuiet() {
  const deadline = Date.now() + 15000;
  while (Date.now() - lastNetworkEvent < 3000) {
    assert(!monitorFailed, 'CI network monitor unavailable');
    assert(Date.now() < deadline, 'CI Docker network did not settle');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(!monitorFailed, 'CI network monitor unavailable');
  return { eventsObserved: networkEvents, quietWindowMs: 3000 };
}

function docker(args: string[]) {
  return execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}
try {
  const config = join(temporary, 'Caddyfile');
  // Exercise the actual production routes, replacing only certificate issuance.
  const production = await readFile('infra/reverse-proxy/Caddyfile', 'utf8');
  await writeFile(
    config,
    '{\n admin off\n auto_https disable_redirects\n}\n' +
      production
        .replace('{$PANEL_DOMAIN} {', domains[0] + ' {\n tls internal')
        .replace('{$ADMIN_DOMAIN} {', domains[1] + ' {\n tls internal'),
  );
  docker([
    'create',
    '--name',
    container,
    '--network',
    network,
    '--publish',
    `127.0.0.1:${port}:${port}`,
    'caddy:2.10.2-alpine',
  ]);
  created = true;
  docker(['cp', config, container + ':/etc/caddy/Caddyfile']);
  docker(['start', container]);
  const caPath = join(temporary, 'root.crt');
  let ca: Buffer | undefined;
  for (let i = 0; i < 40 && !ca; i++) {
    try {
      docker([
        'cp',
        container + ':/data/caddy/pki/authorities/local/root.crt',
        caPath,
      ]);
      ca = await readFile(caPath);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(ca, 'Caddy 未生成测试 CA');
  async function request(
    domain: string,
    path: string,
    trusted = true,
    method = 'GET',
    extraHeaders: Record<string, string> = {},
  ) {
    return new Promise<{
      status: number;
      headers: Record<string, unknown>;
      body: string;
      protocol: string | null;
    }>((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          servername: domain,
          path,
          method,
          headers: { Host: domain + ':' + port, ...extraHeaders },
          ...(trusted ? { ca } : {}),
          rejectUnauthorized: true,
          timeout: 5000,
        },
        (res) => {
          let body = '';
          const protocol = (
            res.socket as import('node:tls').TLSSocket
          ).getProtocol();
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body,
              protocol,
            }),
          );
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(Error('TLS 测试超时')));
      req.end();
    });
  }
  const web = await request(domains[0], '/');
  assert.equal(web.status, 200);
  assert(web.body.includes('统一控制面板'));
  assert.equal(web.headers['strict-transport-security'], 'max-age=31536000');
  assert(web.headers['content-security-policy']);
  const admin = await request(domains[1], '/');
  assert.equal(admin.status, 200);
  assert(admin.body.includes('管理控制台'));
  const ready = await request(domains[0], '/api/ready');
  assert.equal(ready.status, 200);
  assert.equal(JSON.parse(ready.body).status, 'ready');
  const denied = await request(domains[0], '/api/me');
  assert.equal(denied.status, 401);
  const error = JSON.parse(denied.body);
  assert.equal(error.code, 'UNAUTHENTICATED');
  assert(error.correlationId);
  assert(!('stack' in error));
  assert.equal(denied.headers['cache-control'], 'no-store');
  await assert.rejects(request(domains[0], '/', false));
  for (const path of ['/api', '/api/missing', '/api/api/me']) {
    const missing = await request(domains[0], path);
    assert(missing.status >= 400);
    assert(!missing.body.includes('<!doctype html>'));
  }
  const callback = await request(
    domains[0],
    '/auth/google/callback?state=invalid&code=fixture',
  );
  assert.equal(callback.status, 403);
  assert.equal(JSON.parse(callback.body).code, 'OIDC_STATE');
  const auth = await request(domains[0], '/auth/google');
  assert.equal(auth.status, 302);
  const authorization = new URL(String(auth.headers.location));
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    'https://fafa888.uk/auth/google/callback',
  );
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const adminApi = await request(domains[1], '/api/me');
  assert.equal(adminApi.status, 404);
  assert(!adminApi.body.includes('<!doctype html>'));
  // Real browser requests cross from the independent Admin build to the main API.
  // Only these isolated test containers see loopback domain mappings; no DNS changes.
  // Docker veth/address transitions can abort Chromium requests with ERR_NETWORK_CHANGED.
  // Wait on actual netlink notifications before launching; do not retry failed assertions.
  const networkReadiness = await waitForNetworkQuiet();
  const eventsBeforeBrowser = networkEvents;
  const browser = await chromium.launch({
    args: [
      '--no-proxy-server',
      '--host-resolver-rules=MAP fafa888.uk 127.0.0.1, MAP a.fafa888.uk 127.0.0.1',
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(20000);
  const page = await context.newPage();
  const diagnostics = await createTlsDiagnostics(page, context);
  diagnostics.add('network-fixture-ready', networkReadiness);
  for (const path of ['/api/me', '/api/admin/users']) {
    const probe = await request(domains[0], path, true, 'OPTIONS', {
      Origin: 'https://a.fafa888.uk',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-csrf-token',
    });
    const headers = corsHeaders(probe.headers as Record<string, string>);
    diagnostics.add('node-preflight', {
      path,
      status: probe.status,
      ...headers,
    });
    assert.equal(probe.status, 204);
    assert.equal(headers.allowOrigin, 'https://a.fafa888.uk');
    assert.equal(headers.allowCredentials, true);
    assert.equal(headers.allowsCsrfHeader, true);
  }
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (/^TLS_STAGE:[a-z-]+:[0-9]{3}$/.test(message.text())) console.log(message.text());
  });
  page.on('pageerror', (error) =>
    browserErrors.push(JSON.stringify(errorCategory(error.message))),
  );
  page.on('console', (message) => {
    if (
      /Content Security Policy|Mixed Content|CORS policy/i.test(message.text())
    )
      browserErrors.push(JSON.stringify(errorCategory(message.text())));
  });
  let browserEvidence: Record<string, unknown>;
  try {
    await page.goto('https://a.fafa888.uk');
    const googleLink = page.getByRole('link', { name: 'G · 使用 Google 登录' });
    await googleLink.waitFor();
    assert.equal(
      await googleLink.getAttribute('href'),
      'https://fafa888.uk/auth/google',
    );
    await page.getByRole('button', { name: '管理员演示', exact: true }).click();
    await page
      .getByRole('heading', { name: '管理概览', exact: true })
      .waitFor();
    const result = await page.evaluate(async () => {
      const base = 'https://fafa888.uk';
      const me = await fetch(base + '/api/me', {
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      });
      const session = await me.json();
      console.info('TLS_STAGE:me:' + me.status);
      const headers = {
        'content-type': 'application/json',
        'x-csrf-token': session.csrf,
      };
      const allowed = await fetch(base + '/api/admin/users', {
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      });
      const denied = await fetch(base + '/api/location_presets', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
        headers: { ...headers, 'x-csrf-token': 'wrong' },
        body: JSON.stringify({ name: 'denied', latitude: 1, longitude: 2 }),
      });
      const source = await fetch(base + '/api/node_sources', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
        headers,
        body: JSON.stringify({
          name: 'TLS fixture',
          kind: 'OWNED_NODE',
          content: 'trojan://fixture@node.example.com:443#TLS',
          authorized: true,
        }),
      });
      console.info('TLS_STAGE:source-create:' + source.status);
      const createdSource = await source.json();
      const patched = await fetch(
        base + '/api/node_sources/' + createdSource.id,
        {
          method: 'PATCH',
          credentials: 'include',
        signal: AbortSignal.timeout(10000),
          headers,
          body: JSON.stringify({ name: 'TLS fixture edited' }),
        },
      );
      const replaced = await fetch(
        base + '/api/node_sources/' + createdSource.id,
        {
          method: 'PUT',
          credentials: 'include',
        signal: AbortSignal.timeout(10000),
          headers,
          body: JSON.stringify({
            name: 'TLS fixture edited',
            kind: 'OWNED_NODE',
            content: 'trojan://fixture@node.example.com:443#TLS',
            authorized: true,
          }),
        },
      );
      const rotated = await fetch(base + '/api/subscription/rotate', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
        headers: { 'x-csrf-token': session.csrf },
      });
      console.info('TLS_STAGE:subscription-rotate:' + rotated.status);
      const subscription = await rotated.json();
      const ws = await new Promise<{ opened: boolean; code: number }>(
        (resolve, reject) => {
          const socket = new WebSocket(
            'wss://fafa888.uk/api/servers/11111111-1111-4111-8111-111111111111/terminal',
          );
          let opened = false;
          const timeout = setTimeout(() => {
            socket.close();
            reject(Error('WSS proxy timeout'));
          }, 10000);
          socket.onopen = () => {
            opened = true;
            socket.send(
              JSON.stringify({ ticket: 'invalid', csrf: session.csrf }),
            );
          };
          socket.onclose = (event) => {
            clearTimeout(timeout);
            resolve({ opened, code: event.code });
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            reject(Error('WSS proxy failed'));
          };
        },
      );
      return {
        me: me.status,
        admin: allowed.status,
        csrfRejected: denied.status,
        source: source.status,
        sourceId: createdSource.id,
        patched: patched.status,
        replaced: replaced.status,
        rotated: rotated.status,
        subscription: subscription.url,
        ws,
      };
    });
    assert.equal(result.me, 200);
    assert.equal(result.admin, 200);
    assert.equal(result.csrfRejected, 403);
    assert.equal(result.source, 200);
    assert.equal(result.patched, 200);
    assert.equal(result.replaced, 200);
    assert.equal(result.rotated, 200);
    assert.equal(result.ws.opened, true);
    assert.equal(result.ws.code, 1008);
    const downloadUrl = new URL(result.subscription);
    assert.equal(downloadUrl.origin, 'https://fafa888.uk');
    assert(downloadUrl.pathname.startsWith('/api/subscription/download/'));
    const download = await request(domains[0], downloadUrl.pathname);
    assert.equal(download.status, 200);
    assert(download.body.includes('proxies:'));
    assert.equal(download.headers['cache-control'], 'no-store');
    const legacy = await request(
      domains[0],
      '/subscription/' + downloadUrl.pathname.split('/').pop(),
    );
    assert.equal(legacy.status, 200);
    const removed = await page.evaluate(async (id) => {
      const base = 'https://fafa888.uk';
      const me = await (
        await fetch(base + '/api/me', { credentials: 'include' })
      ).json();
      const response = await fetch(base + '/api/node_sources/' + id, {
        method: 'DELETE',
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
        headers: { 'x-csrf-token': me.csrf },
      });
      return response.status;
    }, result.sourceId);
    assert.equal(removed, 200);
    await page.goto('https://fafa888.uk/servers');
    await page
      .getByRole('heading', { name: '我的服务器', exact: true })
      .waitFor();
    await page.goto('https://fafa888.uk/locations');
    await page
      .getByRole('heading', { name: '位置中心', exact: true })
      .waitFor();
    assert.deepEqual(browserErrors, []);
    browserEvidence = {
      primarySession: result.me,
      adminAuthorized: result.admin,
      csrfRejected: result.csrfRejected,
      crossOriginPatch: result.patched,
      crossOriginPut: result.replaced,
      crossOriginDelete: removed,
      subscriptionDownload: download.status,
      legacySubscription: legacy.status,
      wssUpgrade: result.ws.opened,
      invalidTicketCloseCode: result.ws.code,
      corsCspMixedContentErrors: browserErrors,
    };
  } finally {
    await mkdir('docs/evidence', { recursive: true });
    try {
      const health = await request(domains[0], '/api/ready');
      diagnostics.add('node-api-after-browser', { status: health.status, tls: health.protocol });
    } catch (error) {
      diagnostics.add('node-api-after-browser', errorCategory(String(error)));
    }
    diagnostics.add('network-fixture-end', {
      eventsAfterBrowserStart: networkEvents - eventsBeforeBrowser,
    });
    const evidence = await diagnostics.snapshot();
    console.log('TLS_BROWSER_DIAGNOSTICS=' + JSON.stringify(evidence));
    await writeFile(
      'docs/evidence/tls-browser-diagnostics.json',
      JSON.stringify(evidence, null, 2) + '\n',
    );
    await context.close();
    await browser.close();
  }

  await mkdir('docs/evidence', { recursive: true });
  await writeFile(
    'docs/evidence/tls-proxy.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        scope:
          '隔离 CI 容器，生产双域名路由与临时内部 CA；浏览器域名仅映射 loopback，未修改 DNS 或生产',
        oauthScope:
          '验证授权跳转、回调路由与无效 state 拒绝；未登录真实 Google 账户',
        sshScope:
          '真实 WSS Upgrade 和无效票据拒绝；正向 SSH fixture 由 integration 测试覆盖，未连接生产 SSH',
        browser: browserEvidence,
        certificateVerified: true,
        untrustedCertificateRejected: true,
        protocol: web.protocol,
        webStatus: web.status,
        adminStatus: admin.status,
        apiReadyStatus: ready.status,
        unauthenticatedApiStatus: denied.status,
        securityHeadersVerified: true,
        errorCorrelationId: true,
        errorStackHidden: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Caddy HTTPS、证书验证、双域名路径代理、管理端跨源会话、订阅下载与 WSS 与 API 错误安全检查通过',
  );
} finally {
  networkMonitor.kill();
  if (created) docker(['rm', '--force', '--volumes', container]);
  await rm(temporary, { recursive: true, force: true });
}

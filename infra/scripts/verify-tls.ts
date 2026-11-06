import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const temporary = await mkdtemp(join(tmpdir(), 'fafa-tls-'));
const container = 'fafa-tls-test-' + randomUUID().slice(0, 8);
const domains = ['panel.fafa.test', 'admin.fafa.test', 'api.fafa.test'];
const port = Number(process.env.FAFA_TLS_TEST_PORT || 9443);
const network = process.env.FAFA_COMPOSE_NETWORK || 'fafa-one-dev_default';
let created = false;
function docker(args: string[]) {
  return execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}
try {
  const config = join(temporary, 'Caddyfile');
  await writeFile(
    config,
    `{\n admin off\n auto_https disable_redirects\n}\n` +
      domains
        .map(
          (domain, i) =>
            `https://${domain}:${port} {\n tls internal\n header Strict-Transport-Security "max-age=31536000"\n reverse_proxy ${['web:8080', 'admin:8080', 'api:4000'][i]}\n}\n`,
        )
        .join('\n'),
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
  async function request(domain: string, path: string, trusted = true) {
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
          headers: { Host: domain + ':' + port },
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
  const ready = await request(domains[2], '/ready');
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
  await mkdir('docs/evidence', { recursive: true });
  await writeFile(
    'docs/evidence/tls-proxy.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        scope: '本地 .test 域名与临时 Caddy 内部 CA；未修改 DNS 或生产',
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
  console.log('Caddy HTTPS、证书验证、三端反向代理与 API 错误安全检查通过');
} finally {
  if (created) docker(['rm', '--force', container]);
  await rm(temporary, { recursive: true, force: true });
}

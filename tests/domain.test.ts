import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { api } from '../packages/ui/src/core';
import {
  backendUrl,
  loginApp,
  terminalUrl,
} from '../packages/ui/src/endpoints';
import {
  assertPublicUrls,
  googleRedirectUri,
  publicOrigin,
} from '../packages/auth/src/urls';
import {
  safeEndpoint,
  errorCategory,
  corsHeaders,
} from '../infra/scripts/tls-diagnostics';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('双域名契约', () => {
  it('网络停滞会结束加载并提示确认结果，避免无限等待或盲目重复提交', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', transport);
    const pending = expect(api('/api/me')).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
  });

  it('读取请求携带会话但不额外触发 CSRF 预检，写入仍携带 CSRF', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('{}'));
    vi.stubGlobal('fetch', transport);
    await api('/api/me', 'GET', undefined, 'synthetic-csrf');
    const read = transport.mock.calls[0][1]!;
    expect(read.credentials).toBe('include');
    expect(read.headers).not.toHaveProperty('x-csrf-token');
    await api(
      '/api/nodes/synthetic',
      'PATCH',
      { enabled: false },
      'synthetic-csrf',
    );
    const write = transport.mock.calls[1][1]!;
    expect(write.credentials).toBe('include');
    expect(write.headers).toHaveProperty('x-csrf-token', 'synthetic-csrf');
  });

  it('用户端使用相对路径；管理端只拼接 Origin，拒绝重复前缀', () => {
    expect(backendUrl('/api/me', '')).toBe('/api/me');
    expect(backendUrl('/api/me', 'https://fafa888.uk/')).toBe(
      'https://fafa888.uk/api/me',
    );
    expect(backendUrl('/auth/google', 'https://fafa888.uk')).toBe(
      'https://fafa888.uk/auth/google',
    );
    expect(() => backendUrl('/api/api/me')).toThrow();
    expect(() => backendUrl('//external.invalid')).toThrow();
    expect(terminalUrl('/api/servers/id/terminal', 'https://fafa888.uk')).toBe(
      'wss://fafa888.uk/api/servers/id/terminal',
    );
  });
  it('登录来源只区分前台与管理后台两个固定值', () => {
    expect(loginApp('fafa888.uk', '443')).toBe('web');
    expect(loginApp('a.fafa888.uk', '443')).toBe('admin');
    expect(loginApp('localhost', '5173')).toBe('web');
    expect(loginApp('localhost', '5174')).toBe('admin');
    expect(backendUrl('/auth/google?app=admin', 'https://fafa888.uk')).toBe(
      'https://fafa888.uk/auth/google?app=admin',
    );
    expect(backendUrl('/auth/google?app=web', 'https://fafa888.uk')).toBe(
      'https://fafa888.uk/auth/google?app=web',
    );
  });
  it('生产 Origin 与 OAuth 回调固定，拒绝混合内容和 /api/api 配置', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEB_ORIGIN', 'https://fafa888.uk');
    vi.stubEnv('ADMIN_ORIGIN', 'https://a.fafa888.uk');
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'https://fafa888.uk/auth/google/callback',
    );
    expect(assertPublicUrls).not.toThrow();
    expect(publicOrigin()).toBe('https://fafa888.uk');
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk/api');
    expect(assertPublicUrls).toThrow();
    vi.stubEnv('API_PUBLIC_URL', 'http://fafa888.uk');
    expect(assertPublicUrls).toThrow();
    vi.stubEnv('API_PUBLIC_URL', 'https://fafa888.uk');
    vi.stubEnv('GOOGLE_REDIRECT_URI', '');
    expect(googleRedirectUri()).toBe('https://fafa888.uk/auth/google/callback');
    vi.stubEnv(
      'GOOGLE_REDIRECT_URI',
      'https://a.fafa888.uk/auth/google/callback',
    );
    expect(assertPublicUrls).toThrow();
  });
  it('生产 Compose 仅代理发布端口，数据卷与容器安全选项保留', () => {
    const source = readFileSync('infra/docker/compose.production.yaml', 'utf8');
    expect(source).not.toContain('API_DOMAIN');
    const compose = parse(source, { merge: true });
    for (const [name, service] of Object.entries<any>(compose.services)) {
      if (name !== 'proxy') {
        expect(service.ports).toBeUndefined();
        expect(service.network_mode).not.toBe('host');
      }
    }
    expect(compose.services.api.read_only).toBe(true);
    expect(compose.services.api.cap_drop).toEqual(['ALL']);
    expect(compose.services.api.security_opt).toContain(
      'no-new-privileges:true',
    );
    expect(compose.services.postgres.volumes).toContain(
      'pg:/var/lib/postgresql/data',
    );
    expect(Object.keys(compose.volumes)).toEqual([
      'pg',
      'caddy',
      'caddy_config',
    ]);
  });
});

describe('TLS 诊断脱敏', () => {
  it('不保存 URL 凭据、查询参数、订阅路径或错误原文', () => {
    const secret = 'synthetic-private-value';
    const values = [
      safeEndpoint(
        'https://user:' + secret + '@fafa888.uk/api/me?token=' + secret,
      ),
      safeEndpoint('https://fafa888.uk/api/subscription/download/' + secret),
      safeEndpoint('https://untrusted.example/private?token=' + secret),
      errorCategory('net::ERR_HTTP2_PROTOCOL_ERROR token=' + secret),
      corsHeaders({
        'Access-Control-Allow-Origin': 'https://a.fafa888.uk',
        'Access-Control-Allow-Credentials': 'true',
        'set-cookie': secret,
        authorization: secret,
      }),
    ];
    expect(JSON.stringify(values)).not.toContain(secret);
    expect(values[0]).toEqual({
      origin: 'https://fafa888.uk',
      path: '/api/me',
    });
    expect(values[1]).toEqual({
      origin: 'https://fafa888.uk',
      path: 'REDACTED_PATH',
    });
    expect(values[3]).toMatchObject({
      networkCode: 'net::ERR_HTTP2_PROTOCOL_ERROR',
    });
    expect(
      corsHeaders({ 'access-control-allow-origin': '*' }).allowOrigin,
    ).toBe('INVALID_URL');
  });
});

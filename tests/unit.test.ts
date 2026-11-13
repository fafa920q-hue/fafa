import { describe, it, expect, vi } from 'vitest';
import {
  parseSubscription,
  exportSubscription,
  identity,
  deduplicate,
} from '../packages/subscription/src';
import {
  publicAddress,
  validateUrl,
} from '../packages/subscription/src/network';
import { seal, unseal } from '../packages/shared/src/crypto';
import { mockEnabled, assertEnvironment } from '../packages/auth/src';
import { hostKeyMatches } from '../apps/api/src/ssh';
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<any>()),
  lookup: vi.fn(),
}));
const uris = [
  'vless://550e8400-e29b-41d4-a716-446655440000@node.example.com:443?security=tls&type=ws&path=%2Fws&host=edge.example.com&sni=edge.example.com#日本',
  'vmess://' +
    Buffer.from(
      JSON.stringify({
        ps: '美国',
        add: 'node.example.com',
        port: '443',
        id: '550e8400-e29b-41d4-a716-446655440000',
        net: 'tcp',
        tls: 'tls',
      }),
    ).toString('base64'),
  'trojan://my-password@node.example.com:443?sni=node.example.com#新加坡',
  'ss://' +
    Buffer.from('aes-256-gcm:password').toString('base64url') +
    '@node.example.com:8388#香港',
  'hysteria2://password@node.example.com:443?sni=node.example.com#英国',
];
describe('订阅格式支持矩阵', () => {
  for (const [i, uri] of uris.entries())
    for (const format of ['uri', 'base64', 'mihomo', 'sing-box'])
      it(`${i} → ${format} 规范化往返`, () => {
        const nodes = parseSubscription(uri);
        const converted = parseSubscription(exportSubscription(nodes, format));
        expect(identity(converted[0])).toBe(identity(nodes[0]));
      });
  it('完整身份去重，密钥不同不能合并', () => {
    const [node] = parseSubscription(uris[2]);
    expect(
      deduplicate([
        node,
        { ...node, name: '别名' },
        { ...node, credential: 'different' },
      ]),
    ).toHaveLength(2);
  });
  it('拒绝 Reality、SS 插件和不支持的传输', () => {
    expect(() =>
      parseSubscription(uris[0].replace('security=tls', 'security=reality')),
    ).toThrow();
    expect(() =>
      parseSubscription(uris[3].replace('#香港', '?plugin=bad#香港')),
    ).toThrow();
    expect(() =>
      parseSubscription('vless://key@n.example:443?type=grpc'),
    ).toThrow();
  });
  it('拒绝 YAML 别名展开、非法端口与超大内容', () => {
    expect(() => parseSubscription('proxies: &a [*a]')).toThrow();
    expect(() => parseSubscription('trojan://pass@n.example:99999')).toThrow();
    expect(() => parseSubscription('a'.repeat(1048577))).toThrow();
  });
});
describe('安全边界', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])
    it('拦截 ' + ip, () => expect(publicAddress(ip)).toBe(false));
  it('接受公共地址', () => expect(publicAddress('8.8.8.8')).toBe(true));
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com:8443',
    'file:///etc/passwd',
  ])
    it('拒绝 URL ' + url, () => expect(() => validateUrl(url)).toThrow());
  it('信封加密、认证标签与密钥版本', () => {
    const encrypted = seal('secret-value');
    expect(JSON.stringify(encrypted)).not.toContain('secret-value');
    expect(unseal(encrypted)).toBe('secret-value');
    expect(() => unseal({ ...encrypted, keyId: 'not-loaded' })).toThrow();
    expect(() =>
      unseal({
        ...encrypted,
        value: { ...encrypted.value, tag: Buffer.alloc(16).toString('base64') },
      }),
    ).toThrow();
  });
  it('主机指纹改变或未固定必须拒绝', () => {
    expect(hostKeyMatches('abc', 'abc')).toBe(true);
    expect(hostKeyMatches('abc', 'def')).toBe(false);
    expect(hostKeyMatches('', '')).toBe(false);
  });
  it('生产环境硬禁开发登录与演示', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(mockEnabled()).toBe(false);
    expect(assertEnvironment).toThrow();
    vi.unstubAllEnvs();
  });
});

describe('DNS rebinding 防护', () => {
  it('解析结果中任何私有地址均拒绝，全部公共地址只选择已核验记录', async () => {
    const dns = await import('node:dns/promises');
    const spy = vi.mocked(dns.lookup);
    spy.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as any);
    const { resolvePublic } =
      await import('../packages/subscription/src/network');
    await expect(resolvePublic('mixed.example')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
    spy.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as any);
    expect(await resolvePublic('public.example')).toEqual({
      address: '8.8.8.8',
      family: 4,
    });
    spy.mockRestore();
  });
});

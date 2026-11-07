import { describe, it, expect } from 'vitest';
import {
  parseBatch,
  parseSubscription,
  exportSubscription,
  identity,
} from '../packages/subscription/src';
const password = 'fictional:fixture+password';
const name = '🇭🇰 香港 IEPL 0.5倍 下载专用';
const ss =
  'ss://' +
  Buffer.from('aes-256-gcm:' + password).toString('base64url') +
  '@node.example.com:8388#' +
  encodeURIComponent(name);
const vmess = {
  v: '2',
  ps: '日本 2x IEPL',
  add: 'vmess.example.com',
  port: '443',
  id: '550e8400-e29b-41d4-a716-446655440000',
  aid: '16',
  scy: 'aes-128-gcm',
  net: 'ws',
  type: 'none',
  host: 'edge.example.com',
  path: '/fixture?x=1',
  tls: 'tls',
  sni: 'tls.example.com',
};
describe('SS / VMess 兼容及凭据保护', () => {
  it('支持 SS SIP002、旧版整串 Base64、URI 编码及订阅 Base64', () => {
    const standard =
      'ss://' +
      Buffer.from('aes-256-gcm:???').toString('base64') +
      '@node.example.com:8388#fixture';
    expect(parseSubscription(standard)[0].credential).toBe('???');
    const full =
      'ss://' +
      Buffer.from(
        'aes-256-gcm:' + password + '@node.example.com:8388',
      ).toString('base64') +
      '#' +
      encodeURIComponent(name);
    for (const input of [
      ss,
      full,
      encodeURIComponent(ss),
      Buffer.from(ss).toString('base64'),
    ]) {
      const [node] = parseSubscription(input);
      expect(node.credential).toBe(password);
      expect(node.name).toBe(name);
      expect(node.country).toBe('香港');
      expect(node.tags).toContain('IEPL');
      expect(node.tags).toContain('0.5倍');
      expect(node.tags).toContain('下载专用');
    }
  });
  it('保留 VMess UUID、AlterID、加密、TLS 与 WebSocket 参数，各格式往返不变', () => {
    const [original] = parseSubscription(JSON.stringify(vmess));
    for (const format of ['uri', 'base64', 'mihomo', 'sing-box']) {
      const [node] = parseSubscription(exportSubscription([original], format));
      expect(identity(node)).toBe(identity(original));
      expect(node.alterId).toBe(16);
      expect(node.security).toBe('aes-128-gcm');
      expect(node.path).toBe('/fixture?x=1');
      expect(node.sni).toBe('tls.example.com');
      expect(node.country).toBe('日本');
    }
  });
  it('相同连接保留别名标签；同名不同连接保留；失败信息不含原始凭据', () => {
    const result = parseBatch(
      ss +
        '\n' +
        ss.replace(
          encodeURIComponent(name),
          encodeURIComponent('香港 IEPL 备用'),
        ) +
        '\n' +
        ss.replace(':8388#', ':8389#') +
        '\nss://invalid-sensitive-fixture',
    );
    expect(result.nodes).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.nodes[0].aliases).toContain('香港 IEPL 备用');
    expect(JSON.stringify(result.failures)).not.toContain(
      'invalid-sensitive-fixture',
    );
    expect(result.failures).toEqual([{ line: 4, code: 'PARSE_FAILED' }]);
  });
  it('不支持的传输、插件与不安全 TLS 明确失败，不静默改写', () => {
    for (const value of [
      { ...vmess, net: 'grpc' },
      { ...vmess, allowInsecure: true },
      { ...vmess, id: 'invalid' },
    ])
      expect(parseBatch(JSON.stringify(value)).nodes).toHaveLength(0);
    expect(
      parseBatch(ss.replace('#', '?plugin=unsupported#')).failures,
    ).toHaveLength(1);
  });
});

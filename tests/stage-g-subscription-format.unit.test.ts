import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_DOWNLOAD_FORMATS,
  normalizeSubscriptionFormat,
} from '../packages/shared/src/subscription-format';
import {
  exportSubscription,
  type Node,
} from '../packages/subscription/src/index';

// 與隔離種子節點 t1 相同的最小 vless 節點。
const sampleNode = {
  name: 't1',
  protocol: 'vless',
  host: '192.0.2.1',
  port: 443,
  credential: '00000000-0000-4000-8000-000000000001',
  tls: false,
  sni: '',
  transport: 'tcp',
} as unknown as Node;

describe('subscription download formats (stage G: clash alias)', () => {
  it('接受 clash 作為查詢格式，並保留全部既有格式', () => {
    expect(SUBSCRIPTION_DOWNLOAD_FORMATS).toEqual([
      'mihomo',
      'sing-box',
      'uri',
      'base64',
      'shadowrocket',
      'v2rayn',
      'clash',
    ]);
    expect(SUBSCRIPTION_DOWNLOAD_FORMATS).not.toContain('bogus');
  });

  it('clash 對映為 mihomo；shadowrocket / v2rayn 對映不變；其餘格式維持原值', () => {
    expect(normalizeSubscriptionFormat('clash')).toBe('mihomo');
    expect(normalizeSubscriptionFormat('shadowrocket')).toBe('uri');
    expect(normalizeSubscriptionFormat('v2rayn')).toBe('base64');
    expect(normalizeSubscriptionFormat('mihomo')).toBe('mihomo');
    expect(normalizeSubscriptionFormat('sing-box')).toBe('sing-box');
    expect(normalizeSubscriptionFormat('uri')).toBe('uri');
    expect(normalizeSubscriptionFormat('base64')).toBe('base64');
  });

  it('clash 經對映後的 YAML 輸出與 mihomo 完全相同', () => {
    const viaClash = exportSubscription(
      [sampleNode],
      normalizeSubscriptionFormat('clash'),
    );
    const viaMihomo = exportSubscription([sampleNode], 'mihomo');
    expect(viaClash).toBe(viaMihomo);
    expect(viaMihomo).toContain('proxies:');
    expect(viaMihomo).toContain('proxy-groups:');
    expect(viaMihomo).toContain('t1');
    expect(viaMihomo).toContain('192.0.2.1');
  });

  it('既有格式輸出不變：sing-box 為 JSON；base64 解碼後為 vless 連結', () => {
    const singbox = exportSubscription([sampleNode], 'sing-box');
    const parsed = JSON.parse(singbox) as {
      outbounds: Array<Record<string, unknown>>;
    };
    expect(parsed.outbounds).toHaveLength(1);
    expect(parsed.outbounds[0].server).toBe('192.0.2.1');
    const decoded = Buffer.from(
      exportSubscription([sampleNode], 'base64'),
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('vless://');
  });
});

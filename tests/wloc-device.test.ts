import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deviceUrl,
  queryDevice,
  saveDevice,
  clearDevice,
  diagnoseDevice,
  diagnoseDevices,
  deviceFailure,
} from '../apps/web/src/locations/device';
const host = 'gs-loc.apple.com';
const point = { latitude: 48.85, longitude: 2.35 };
const settings = { success: true, ...point, accuracy: 25, randomRadius: 0 };
function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('uses exact original WLOC GET protocol and no FAFA credentials/CSRF', async () => {
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) =>
    json(settings),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(deviceUrl(host, 'save', point, 25, 0)).toBe(
    'https://gs-loc.apple.com/wloc-settings/save?lon=2.35&lat=48.85&acc=25&randomRadius=0',
  );
  await expect(saveDevice(host, point, 25, 0)).resolves.toMatchObject(point);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain('action=query');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(
    /x-csrf|authorization|cookie/i,
  );
});
it('requires matching readback, never optimistic success', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json(settings))
      .mockResolvedValueOnce(json({ ...settings, longitude: 3 })),
  );
  await expect(saveDevice(host, point, 25, 0)).rejects.toThrow('回读不匹配');
});
it('clear succeeds only after exact empty-state readback', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ success: true }))
    .mockResolvedValueOnce(json({ success: false, error: '无已保存的坐标' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(clearDevice(host)).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toContain('action=clear');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(settings)),
  );
  await expect(clearDevice(host)).rejects.toThrow('清除未确认');
});
it('surfaces missing module, CORS, non-JSON, HTTP error and unknown empty errors as failure', async () => {
  for (const factory of [
    async () => {
      throw new TypeError('Failed to fetch');
    },
    async () => new Response('<html>Apple</html>'),
    async () => new Response('{}', { status: 403 }),
    async () => json({ success: false, error: 'anything' }),
    async () => json({ success: true, latitude: 500, longitude: 3 }),
  ]) {
    vi.stubGlobal('fetch', vi.fn(factory));
    await expect(queryDevice(host)).rejects.toThrow();
  }
  expect(deviceFailure).toContain('网页无法区分');
});
it('aborts bounded requests without retrying or claiming success', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(Error('aborted')),
        ),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const promise = expect(queryDevice(host)).rejects.toThrow(deviceFailure);
  await vi.advanceTimersByTimeAsync(8001);
  await promise;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects unsupported zero coordinates and invalid parameters before network access', () => {
  for (const point of [
    { latitude: 0, longitude: 2 },
    { latitude: 2, longitude: 0 },
  ])
    expect(() => deviceUrl(host, 'save', point)).toThrow('零');
  expect(() => deviceUrl('evil.invalid' as any, 'query')).toThrow();
  expect(() => deviceUrl(host, 'save', point, NaN)).toThrow();
});
it('diagnosis distinguishes network, http and invalid failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  await expect(diagnoseDevice(host)).resolves.toMatchObject({
    host,
    detected: false,
    kind: 'network',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>Apple</html>')),
  );
  await expect(diagnoseDevice(host)).resolves.toMatchObject({
    detected: false,
    kind: 'http',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ success: 'yes' })),
  );
  await expect(diagnoseDevice(host)).resolves.toMatchObject({
    detected: false,
    kind: 'invalid',
  });
});
it('diagnosis reports empty state as detected module without saved coordinates', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ success: false, error: '无已保存的坐标' })),
  );
  await expect(diagnoseDevice(host)).resolves.toMatchObject({
    host,
    detected: true,
    kind: 'empty',
  });
});
it('diagnosis reports saved settings as detected module', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(settings)),
  );
  const result = await diagnoseDevice(host);
  expect(result.detected).toBe(true);
  expect(result.kind).toBe('ok');
  expect(result.settings).toMatchObject(point);
});
it('diagnosis covers both device hosts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ success: false, error: '无已保存的坐标' })),
  );
  const results = await diagnoseDevices();
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.host)).toEqual([
    'gs-loc.apple.com',
    'gs-loc-cn.apple.com',
  ]);
  expect(results.every((r) => r.detected)).toBe(true);
});

describe('WLOC 失效说明（2026-11-04 钉扎）', () => {
  const setupGuide = readFileSync(
    'apps/web/src/locations/SetupGuide.tsx',
    'utf8',
  );
  const locationCenter = readFileSync(
    'apps/web/src/locations/LocationCenter.tsx',
    'utf8',
  );

  it('位置页常显提示写明核心原因与解决方法', () => {
    expect(locationCenter).toContain('为什么 WLOC 突然失效了');
    expect(locationCenter).toContain('pinningrules.sqlite3');
    expect(locationCenter).toContain('-67880');
    expect(locationCenter).toContain('恢复出厂设置回到 1013');
    expect(locationCenter).toContain('updates.cdn-apple.com');
  });

  it('指南专节保留诊断清单并纠正 Safari 404 的判断口径', () => {
    expect(setupGuide).toContain('先确认是不是这个问题');
    expect(setupGuide).toContain('不能单独确认钉扎问题');
    expect(setupGuide).toContain('受信任资产版本');
    expect(setupGuide).toContain('1014');
    expect(setupGuide).toContain('1013');
  });

  it('指南专节写明唯一可行的恢复路径与 6 个屏蔽域名', () => {
    expect(setupGuide).toContain('恢复出厂设置');
    expect(setupGuide).toContain('allowOTAPKIUpdates=false');
    for (const domain of [
      'gdmf.apple.com',
      'gdmf-ados.apple.com',
      'mesu.apple.com',
      'updates.cdn-apple.com',
      'updates-http.cdn-apple.com',
      'appldnld.apple.com',
    ]) {
      expect(setupGuide).toContain(domain);
    }
  });

  it('指南专节写明代价、不可行办法与切勿事项', () => {
    expect(setupGuide).toContain('7 天');
    expect(setupGuide).toContain('48 小时');
    expect(setupGuide).toContain('iOS 27');
    expect(setupGuide).toContain('停止签名');
    expect(setupGuide).toContain('公开越狱：不存在');
    expect(setupGuide).toContain('isSimulatedBySoftware=true');
  });
});

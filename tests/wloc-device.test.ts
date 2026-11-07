import { afterEach, expect, it, vi } from 'vitest';
import { deviceUrl, queryDevice, saveDevice, clearDevice, deviceFailure } from '../apps/web/src/locations/device';
const host = 'gs-loc.apple.com';
const point = { latitude: 48.85, longitude: 2.35 };
const settings = { success: true, ...point, accuracy: 25, randomRadius: 0 };
function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('uses exact original WLOC GET protocol and no FAFA credentials/CSRF', async () => {
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json(settings)); vi.stubGlobal('fetch', fetcher);
  expect(deviceUrl(host, 'save', point, 25, 0)).toBe('https://gs-loc.apple.com/wloc-settings/save?lon=2.35&lat=48.85&acc=25&randomRadius=0');
  await expect(saveDevice(host, point, 25, 0)).resolves.toMatchObject(point);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain('action=query');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', mode: 'cors', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/x-csrf|authorization|cookie/i);
});
it('requires matching readback, never optimistic success', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(settings)).mockResolvedValueOnce(json({ ...settings, longitude: 3 })));
  await expect(saveDevice(host, point, 25, 0)).rejects.toThrow('回读不匹配');
});
it('clear succeeds only after exact empty-state readback', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(json({ success: false, error: '无已保存的坐标' }));
  vi.stubGlobal('fetch', fetcher);
  await expect(clearDevice(host)).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0][0]).toContain('action=clear');
  vi.stubGlobal('fetch', vi.fn(async () => json(settings)));
  await expect(clearDevice(host)).rejects.toThrow('清除未确认');
});
it('surfaces missing module, CORS, non-JSON, HTTP error and unknown empty errors as failure', async () => {
  for (const factory of [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => new Response('<html>Apple</html>'),
    async () => new Response('{}', { status: 403 }),
    async () => json({ success: false, error: 'anything' }),
    async () => json({ success: true, latitude: 500, longitude: 3 }),
  ]) { vi.stubGlobal('fetch', vi.fn(factory)); await expect(queryDevice(host)).rejects.toThrow(); }
  expect(deviceFailure).toContain('网页无法区分');
});
it('aborts bounded requests without retrying or claiming success', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))));
  vi.stubGlobal('fetch', fetcher);
  const promise = expect(queryDevice(host)).rejects.toThrow(deviceFailure);
  await vi.advanceTimersByTimeAsync(8001); await promise;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects unsupported zero coordinates and invalid parameters before network access', () => {
  for (const point of [{ latitude: 0, longitude: 2 }, { latitude: 2, longitude: 0 }]) expect(() => deviceUrl(host, 'save', point)).toThrow('零');
  expect(() => deviceUrl('evil.invalid' as any, 'query')).toThrow();
  expect(() => deviceUrl(host, 'save', point, NaN)).toThrow();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coordinate,
  toWgs84,
  fromWgs84,
  parseMapLink,
  mapUrl,
} from '../packages/shared/src/wloc';
import { mapFetch, locationTools } from '../apps/api/src/location-tools';
describe('WLOC independent coordinates and map links', () => {
  it('rejects empty, non-numeric and out-of-range coordinates without corrupting zero', () => {
    expect(coordinate(0, 0)).toEqual({ latitude: 0, longitude: 0 });
    for (const p of [
      [null, 1],
      ['', 1],
      [true, 2],
      [Infinity, 1],
      [91, 2],
      [0, 181],
    ])
      expect(() => coordinate(...(p as [unknown, unknown]))).toThrow();
  });
  it('matches Beijing GCJ-02 reference and round trips BD-09', () => {
    const p = { longitude: 116.404, latitude: 39.915 };
    const gcj = fromWgs84(p, 'GCJ02');
    expect(gcj.longitude).toBeCloseTo(116.4102445, 5);
    expect(gcj.latitude).toBeCloseTo(39.9164043, 5);
    for (const system of ['GCJ02', 'BD09'] as const) {
      const result = toWgs84(fromWgs84(p, system), system);
      expect(result.longitude).toBeCloseTo(p.longitude, 5);
      expect(result.latitude).toBeCloseTo(p.latitude, 5);
    }
    expect(toWgs84({ latitude: 48.85, longitude: 2.35 }, 'GCJ02')).toEqual({
      latitude: 48.85,
      longitude: 2.35,
    });
  });
  it('preserves Apple WGS84 outside China and requires explicit Chinese/HK/TW CRS', () => {
    expect(parseMapLink('https://maps.apple.com/?ll=48.85,2.35')).toMatchObject(
      { latitude: 48.85, longitude: 2.35 },
    );
    for (const ll of ['31.23,121.47', '22.3,114.17', '25.03,121.56']) {
      expect(() => parseMapLink('https://maps.apple.com/?ll=' + ll)).toThrow(
        '坐标系',
      );
      expect(
        parseMapLink('https://maps.apple.com/?ll=' + ll, 'WGS84').sourceSystem,
      ).toBe('WGS84');
    }
  });
  it('parses Amap ordering, Baidu declared CRS and Google actual pin rather than viewport', () => {
    const amap = parseMapLink(
      'https://uri.amap.com/marker?position=116.4102445,39.9164043&name=%E5%8C%97%E4%BA%AC',
    );
    expect(amap.latitude).toBeCloseTo(39.915, 5);
    expect(amap.name).toBe('北京');
    expect(
      parseMapLink('https://uri.amap.com/marker?p=B001,39.9164043,116.4102445')
        .longitude,
    ).toBeCloseTo(116.404, 5);
    expect(
      parseMapLink(
        'https://api.map.baidu.com/marker?location=48.85,2.35&coord_type=wgs84',
      ),
    ).toMatchObject({ latitude: 48.85, longitude: 2.35 });
    expect(
      parseMapLink(
        'https://www.google.com/maps/place/X/@1,2,3z/data=!3d48.85!4d2.35',
      ),
    ).toMatchObject({ latitude: 48.85, longitude: 2.35 });
    expect(() =>
      parseMapLink('https://www.google.com/maps/place/X/@1,2,3z'),
    ).toThrow('长链接');
  });
  it('Baidu declared CRS and overseas ambiguity', () => {
    expect(
      parseMapLink(
        'https://api.map.baidu.com/marker?location=48.85,2.35&coord_type=wgs84ll',
      ),
    ).toMatchObject({ latitude: 48.85, longitude: 2.35 });
    expect(() =>
      parseMapLink('https://map.baidu.com/?location=48.85,2.35'),
    ).toThrow('坐标系');
    expect(
      parseMapLink('https://map.baidu.com/?location=48.85,2.35', 'WGS84'),
    ).toMatchObject({ latitude: 48.85, longitude: 2.35 });
    for (const type of ['unknown', 'constructor', '__proto__']) {
      const url =
        'https://map.baidu.com/?location=39.9,116.4&coord_type=' + type;
      expect(() => parseMapLink(url)).toThrow('不支持');
    }
    const mc = parseMapLink(
      'https://api.map.baidu.com/marker?location=4825907,12958160&coord_type=bd09mc',
    );
    expect(mc.sourceSystem).toBe('BD09MC');
    expect(mc.latitude).toBeGreaterThan(39);
    expect(mc.latitude).toBeLessThan(40);
    expect(mc.longitude).toBeGreaterThan(116);
    expect(mc.longitude).toBeLessThan(117);
    expect(() => mapUrl('https://%%/')).toThrow('地图链接格式无效');
  });
  it('rejects lookalike hosts, credentials, ports, local addresses and javascript', () => {
    for (const url of [
      'https://maps.apple.com.evil.invalid/?ll=1,2',
      'https://127.0.0.1/',
      'https://maps.apple.com:444/',
      'https://user:pass@maps.apple.com/',
      'javascript:alert(1)',
      'https://gs-loc.apple.com/wloc-settings/save',
    ])
      expect(() => mapUrl(url)).toThrow();
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('bounded map provider operations', () => {
  it('deduplicates concurrent public provider access, caches query and validates GeoJSON', async () => {
    const fetcher = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({
        features: [
          {
            geometry: { type: 'Point', coordinates: [2.35, 48.85] },
            properties: { name: 'Paris', country: 'France' },
          },
          {
            geometry: { type: 'Point', coordinates: [400, 100] },
            properties: { name: 'invalid' },
          },
        ],
      }),
    }));
    const tools = locationTools(fetcher, () => 10000);
    const first = tools.search('Paris');
    await expect(tools.search('London')).rejects.toMatchObject({
      code: 'MAP_BUSY',
    });
    const r = await first;
    expect(r).toMatchObject({
      results: [{ latitude: 48.85, longitude: 2.35, name: 'Paris · France' }],
    });
    await expect(tools.search('Paris')).resolves.toEqual(r);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not accept search redirect or fake empty results on failure', async () => {
    for (const response of [
      { status: 302, body: '', location: 'https://127.0.0.1/' },
      { status: 200, body: 'bad-json' },
    ]) {
      await expect(
        locationTools(async () => response).search('Paris'),
      ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    }
    vi.stubEnv('WLOC_SEARCH_ENABLED', 'false');
    await expect(locationTools().search('Paris')).rejects.toMatchObject({
      code: 'SEARCH_DISABLED',
    });
  });
  it('expands only allowed map redirects and never fetches untrusted or Apple device endpoints', async () => {
    const safe = vi.fn(async () => ({
      status: 302,
      body: '',
      location: 'https://maps.apple.com/?ll=48.85,2.35',
    }));
    await expect(
      locationTools(safe).resolve('https://maps.apple/p/fixture', 'AUTO'),
    ).resolves.toMatchObject({ latitude: 48.85 });
    expect(safe).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => ({
      status: 302,
      body: '',
      location: 'https://169.254.169.254/latest/meta-data/',
    }));
    await expect(
      locationTools(bad).resolve('https://surl.amap.com/fixture', 'AUTO'),
    ).rejects.toMatchObject({ code: 'MAP_LINK_UNRESOLVED' });
    expect(bad).toHaveBeenCalledTimes(1);
    const never = vi.fn();
    await expect(
      locationTools(never).resolve(
        'https://gs-loc.apple.com/wloc-settings/save',
        'AUTO',
      ),
    ).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
  });
  it('bounds redirect loops, private targets and ambiguous Chinese coordinates', async () => {
    const redirect = vi.fn(async () => ({
      status: 302,
      body: '',
      location: 'https://surl.amap.com/again',
    }));
    await expect(
      locationTools(redirect).resolve('https://surl.amap.com/start', 'AUTO'),
    ).rejects.toThrow();
    expect(redirect).toHaveBeenCalledTimes(4);
    await expect(
      locationTools().resolve(
        'https://maps.apple.com/?ll=31.23,121.47',
        'AUTO',
      ),
    ).rejects.toMatchObject({ code: 'MAP_LINK_INVALID' });
  });
});

it('blocks literal private/loopback/metadata targets before any TLS connection', async () => {
  for (const host of [
    '127.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '[::1]',
    '[::ffff:127.0.0.1]',
  ]) {
    await expect(mapFetch('https://' + host + '/')).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  }
});

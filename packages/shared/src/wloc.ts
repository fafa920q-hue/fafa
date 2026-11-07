// Independent protocol client data types. No Yu9191/wloc source is included.
import gcoord from 'gcoord';
export type CoordinateSystem = 'WGS84' | 'GCJ02' | 'BD09' | 'BD09MC';
export type Point = { latitude: number; longitude: number };
export function validPoint(point: Point) {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}
export function coordinate(latitude: unknown, longitude: unknown): Point {
  if (
    (typeof latitude === 'string' && !latitude.trim()) ||
    (typeof longitude === 'string' && !longitude.trim())
  )
    throw Error('请输入完整经纬度');
  if (
    (typeof latitude !== 'number' && typeof latitude !== 'string') ||
    (typeof longitude !== 'number' && typeof longitude !== 'string')
  )
    throw Error('坐标格式错误');
  const point = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!validPoint(point))
    throw Error('纬度须在-90至90，经度须在-180至180，且均为有限数值');
  return point;
}
export function toWgs84(point: Point, system: CoordinateSystem): Point {
  if (system !== 'BD09MC' && !validPoint(point))
    throw Error('原始坐标超出范围');
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))
    throw Error('坐标格式错误');
  const converted = gcoord.transform(
    [point.longitude, point.latitude],
    gcoord[system],
    gcoord.WGS84,
  );
  return coordinate(converted[1], converted[0]);
}
export function fromWgs84(
  point: Point,
  system: Exclude<CoordinateSystem, 'BD09MC'>,
): Point {
  if (!validPoint(point)) throw Error('坐标超出范围');
  const converted = gcoord.transform(
    [point.longitude, point.latitude],
    gcoord.WGS84,
    gcoord[system],
  );
  return { latitude: converted[1], longitude: converted[0] };
}
export function mapUrl(raw: string) {
  const match = raw.trim().match(/https:\/\/[^\s<>"']+/);
  if (!match) throw Error('请提供HTTPS地图链接');
  const url = new URL(match[0]);
  const host = url.hostname.toLowerCase();
  const allowed = [
    'maps.apple.com',
    'maps.apple',
    'uri.amap.com',
    'surl.amap.com',
    'amap.com',
    'www.amap.com',
    'ditu.amap.com',
    'map.baidu.com',
    'api.map.baidu.com',
    'j.map.baidu.com',
    'maps.google.com',
    'www.google.com',
    'maps.app.goo.gl',
  ];
  if (
    url.protocol !== 'https:' ||
    !allowed.includes(host) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    raw.length > 4096
  )
    throw Error('仅支持列出的苹果、高德、百度和Google地图HTTPS链接');
  url.hash = '';
  return url;
}
function pair(value: string | null) {
  if (!value) return null;
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length < 2 ||
    !parts.slice(0, 2).every((part) => /^-?\d+(?:\.\d+)?$/.test(part))
  )
    return null;
  return [Number(parts[0]), Number(parts[1])];
}
export class MapLinkError extends Error {
  constructor(
    public code: 'EXPAND_REQUIRED' | 'COORDINATE_SYSTEM_REQUIRED',
    message: string,
  ) {
    super(message);
  }
}
export function parseMapLink(
  raw: string,
  requested: CoordinateSystem | 'AUTO' = 'AUTO',
) {
  const url = mapUrl(raw);
  const host = url.hostname;
  let numbers: number[] | null = null;
  let source: 'APPLE' | 'AMAP' | 'BAIDU' | 'GOOGLE';
  let system: CoordinateSystem = 'WGS84';
  let reverse = false;
  if (host.startsWith('maps.apple')) {
    source = 'APPLE';
    numbers = pair(
      url.searchParams.get('coordinate') ||
        url.searchParams.get('ll') ||
        url.searchParams.get('sll'),
    );
    if (
      numbers &&
      requested === 'AUTO' &&
      numbers[1] >= 72 &&
      numbers[1] <= 138 &&
      numbers[0] >= 0.8 &&
      numbers[0] <= 56
    )
      throw new MapLinkError(
        'COORDINATE_SYSTEM_REQUIRED',
        '此区域的苹果地图链接可能使用WGS84或GCJ-02，请明确选择链接坐标系后重试',
      );
  } else if (host.includes('amap.com')) {
    source = 'AMAP';
    system = 'GCJ02';
    const position =
      url.searchParams.get('position') || url.searchParams.get('lnglat');
    if (position) {
      numbers = pair(position);
      reverse = true;
    } else if (url.searchParams.get('p'))
      numbers = pair(url.searchParams.get('p')!.split(',').slice(1).join(','));
    else numbers = pair(url.searchParams.get('q'));
  } else if (host.includes('baidu.com')) {
    source = 'BAIDU';
    system = 'BD09';
    numbers = pair(url.searchParams.get('location'));
    const mc = url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
    if (!numbers && mc) {
      numbers = [Number(mc[2]), Number(mc[1])];
      system = 'BD09MC';
    }
    const type = url.searchParams.get('coord_type');
    if (type === 'wgs84') system = 'WGS84';
    if (type === 'gcj02') system = 'GCJ02';
  } else {
    source = 'GOOGLE';
    const pin = url.pathname.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (pin) numbers = [Number(pin[1]), Number(pin[2])];
    else
      numbers = pair(
        url.searchParams.get('query') || url.searchParams.get('q'),
      );
    if (
      numbers &&
      requested === 'AUTO' &&
      numbers[1] >= 72 &&
      numbers[1] <= 138 &&
      numbers[0] >= 0.8 &&
      numbers[0] <= 56
    )
      throw new MapLinkError(
        'COORDINATE_SYSTEM_REQUIRED',
        '此区域的分享坐标系需要确认，请选择WGS84或GCJ-02',
      );
  }
  if (!numbers)
    throw new MapLinkError(
      'EXPAND_REQUIRED',
      '链接未直接包含坐标，需要安全展开短链接或改用含坐标长链接',
    );
  const rawPoint = {
    latitude: numbers[reverse ? 1 : 0],
    longitude: numbers[reverse ? 0 : 1],
  };
  const chosen = requested === 'AUTO' ? system : requested;
  const point = toWgs84(rawPoint, chosen);
  return {
    ...point,
    coordinateSystem: 'WGS84' as const,
    source,
    sourceSystem: chosen,
    name: (
      url.searchParams.get('name') ||
      url.searchParams.get('q') ||
      ''
    ).slice(0, 80),
  };
}

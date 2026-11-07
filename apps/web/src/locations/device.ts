import {
  coordinate,
  validPoint,
  type Point,
} from '../../../../packages/shared/src/wloc';
export const deviceHosts = ['gs-loc.apple.com', 'gs-loc-cn.apple.com'] as const;
export type DeviceHost = (typeof deviceHosts)[number];
export type DeviceSettings = Point & {
  accuracy: number;
  randomRadius: number;
  updatedAt?: string;
};
export const deviceFailure =
  '未获得有效WLOC模块响应。请检查Shadowrocket、模块、HTTPS解密、证书信任、CORS或iOS兼容性；网页无法区分这些原因。';
export function deviceUrl(
  host: DeviceHost,
  action: 'query' | 'clear' | 'save',
  point?: Point,
  accuracy = 25,
  randomRadius = 0,
) {
  if (!deviceHosts.includes(host)) throw Error('不允许的设备接口');
  const url = new URL('https://' + host + '/wloc-settings/save');
  if (action === 'save') {
    if (
      !point ||
      !validPoint(point) ||
      !Number.isInteger(accuracy) ||
      accuracy < 1 ||
      accuracy > 10000 ||
      !Number.isInteger(randomRadius) ||
      randomRadius < 0 ||
      randomRadius > 100000
    )
      throw Error('设备参数无效');
    if (point.latitude === 0 || point.longitude === 0)
      throw Error(
        '原版模块对零经纬度的读取与应用不可靠，暂不写入零坐标；地图和收藏仍可使用',
      );
    url.searchParams.set('lon', String(point.longitude));
    url.searchParams.set('lat', String(point.latitude));
    url.searchParams.set('acc', String(accuracy));
    url.searchParams.set('randomRadius', String(randomRadius));
  } else url.searchParams.set('action', action);
  return url.toString();
}
async function request(
  host: DeviceHost,
  action: 'query' | 'clear' | 'save',
  point?: Point,
  accuracy?: number,
  radius?: number,
) {
  const url = deviceUrl(host, action, point, accuracy, radius);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw Error(deviceFailure);
    const text = await response.text();
    if (text.length > 8192) throw Error(deviceFailure);
    const body = JSON.parse(text);
    if (!body || typeof body.success !== 'boolean') throw Error(deviceFailure);
    return body;
  } catch {
    throw Error(deviceFailure);
  } finally {
    clearTimeout(timeout);
  }
}
export async function queryDevice(
  host: DeviceHost,
): Promise<DeviceSettings | null> {
  const data = await request(host, 'query');
  if (data.success === false && data.error === '无已保存的坐标') return null;
  if (
    data.success !== true ||
    typeof data.latitude !== 'number' ||
    typeof data.longitude !== 'number'
  )
    throw Error(deviceFailure);
  const point = coordinate(data.latitude, data.longitude);
  const accuracy = Number(data.accuracy),
    randomRadius = Number(data.randomRadius);
  if (
    !Number.isFinite(accuracy) ||
    accuracy <= 0 ||
    !Number.isFinite(randomRadius) ||
    randomRadius < 0
  )
    throw Error(deviceFailure);
  return {
    ...point,
    accuracy,
    randomRadius,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}
export async function saveDevice(
  host: DeviceHost,
  point: Point,
  accuracy: number,
  radius: number,
) {
  const written = await request(host, 'save', point, accuracy, radius);
  if (written.success !== true)
    throw Error('模块未确认写入；请先查询设备配置，不要反复保存');
  const actual = await queryDevice(host);
  if (
    !actual ||
    Math.abs(actual.latitude - point.latitude) > 0.000001 ||
    Math.abs(actual.longitude - point.longitude) > 0.000001 ||
    actual.accuracy !== accuracy ||
    actual.randomRadius !== radius
  )
    throw Error('写入后的设备回读不匹配，保存未确认；请查询设备配置');
  return actual;
}
export async function clearDevice(host: DeviceHost) {
  const cleared = await request(host, 'clear');
  if (cleared.success !== true) throw Error('模块未确认清除');
  const actual = await queryDevice(host);
  if (actual !== null) throw Error('设备仍返回已保存坐标，清除未确认');
}

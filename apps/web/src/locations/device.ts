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
export type DeviceFailureKind = 'network' | 'http' | 'invalid';
export class DeviceRequestError extends Error {
  kind: DeviceFailureKind;
  constructor(kind: DeviceFailureKind, message: string) {
    super(message);
    this.name = 'DeviceRequestError';
    this.kind = kind;
  }
}
export const deviceNetworkHint =
  '请求未得到响应：浏览器未能连通 gs-loc 模块接口。2026-11-04 起，多台 iOS 18/26 设备出现系统拒绝该域名 MITM 证书的情况（上游调查：trustd 的 pinningrules 被热更新，要求 Apple 签发的证书；同一张证书拦截其他域名仍正常）。确认方法：在 Safari 直接打开 https://gs-loc.apple.com/ ，若提示“证书无效 / 未受信任”，即系统已拒绝该域名的 MITM 证书；另可查看“设置 → 通用 → 关于本机”中的受信任资产版本（1014 已确认受影响）。此为系统层限制，网页与模块无法绕过。';
export const deviceHttpHint =
  '服务器返回了非模块应答：请求到达了服务器，但返回的不是 WLOC 模块的 JSON，说明模块未拦截此域名。请检查模块是否启用、MITM 主机是否包含该域名、请求是否走了代理。';
export const deviceInvalidHint =
  '模块响应格式无效：返回了内容，但缺少 success 字段或坐标无效。';
export interface DeviceDiagnosis {
  host: DeviceHost;
  detected: boolean;
  kind: 'ok' | 'empty' | 'network' | 'http' | 'invalid';
  summary: string;
  detail: string;
  settings?: DeviceSettings;
}
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
type DevicePayload = {
  success: boolean;
  error?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  accuracy?: unknown;
  randomRadius?: unknown;
  updatedAt?: unknown;
};

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
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new DeviceRequestError('network', deviceFailure);
    }
    if (
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json')
    )
      throw new DeviceRequestError('http', deviceFailure);
    const text = await response.text();
    if (text.length > 8192)
      throw new DeviceRequestError('invalid', deviceFailure);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DeviceRequestError('invalid', deviceFailure);
    }
    if (!body || typeof (body as { success?: unknown }).success !== 'boolean')
      throw new DeviceRequestError('invalid', deviceFailure);
    return body as DevicePayload;
  } catch (e) {
    if (e instanceof DeviceRequestError) throw e;
    throw new DeviceRequestError('network', deviceFailure);
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
export async function diagnoseDevice(
  host: DeviceHost,
): Promise<DeviceDiagnosis> {
  let data: unknown;
  try {
    data = await request(host, 'query');
  } catch (e) {
    const kind = e instanceof DeviceRequestError ? e.kind : 'network';
    if (kind === 'network')
      return {
        host,
        detected: false,
        kind: 'network',
        summary: '请求未得到响应',
        detail: deviceNetworkHint,
      };
    if (kind === 'http')
      return {
        host,
        detected: false,
        kind: 'http',
        summary: '服务器响应不是模块应答',
        detail: deviceHttpHint,
      };
    return {
      host,
      detected: false,
      kind: 'invalid',
      summary: '模块响应格式无效',
      detail: deviceInvalidHint,
    };
  }
  const body = data as {
    success?: unknown;
    error?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    accuracy?: unknown;
    randomRadius?: unknown;
    updatedAt?: unknown;
  };
  if (body.success === false && body.error === '无已保存的坐标')
    return {
      host,
      detected: true,
      kind: 'empty',
      summary: '模块已检测到，未保存坐标',
      detail:
        '模块正在拦截并正常应答，只是尚未保存坐标。可以选点后保存到设备。',
    };
  if (
    body.success === true &&
    typeof body.latitude === 'number' &&
    typeof body.longitude === 'number'
  ) {
    try {
      const point = coordinate(body.latitude, body.longitude);
      const accuracy = Number(body.accuracy),
        randomRadius = Number(body.randomRadius);
      if (
        Number.isFinite(accuracy) &&
        accuracy > 0 &&
        Number.isFinite(randomRadius) &&
        randomRadius >= 0
      ) {
        const settings: DeviceSettings = {
          ...point,
          accuracy,
          randomRadius,
          updatedAt:
            typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
        };
        return {
          host,
          detected: true,
          kind: 'ok',
          summary: '模块已检测到',
          detail: `设备已保存坐标 ${settings.latitude}, ${settings.longitude} · 精度 ${settings.accuracy}m · 半径 ${settings.randomRadius}m`,
          settings,
        };
      }
    } catch {
      // fall through to invalid below
    }
  }
  return {
    host,
    detected: false,
    kind: 'invalid',
    summary: '模块响应格式无效',
    detail: deviceInvalidHint,
  };
}
export async function diagnoseDevices(): Promise<DeviceDiagnosis[]> {
  const out: DeviceDiagnosis[] = [];
  for (const host of deviceHosts) out.push(await diagnoseDevice(host));
  return out;
}

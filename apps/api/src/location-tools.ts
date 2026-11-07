import https from 'node:https';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../packages/shared/src';
import {
  coordinate,
  mapUrl,
  parseMapLink,
  MapLinkError,
  type CoordinateSystem,
} from '../../../packages/shared/src/wloc';
import {
  resolvePublic,
  validateUrl,
} from '../../../packages/subscription/src/network';
export type MapResponse = { status: number; body: string; location?: string };
export type MapFetch = (url: string) => Promise<MapResponse>;
// DNS validation and pinned lookup apply to EVERY hop; no cookies or client headers forwarded.
export async function mapFetch(raw: string): Promise<MapResponse> {
  const url = validateUrl(raw);
  const record = await resolvePublic(url.hostname);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const finish = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    };
    const req = https.request(
      url,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'accept-encoding': 'identity',
          accept: 'application/json,text/html;q=0.5',
          'user-agent': 'FAFA-ONE-WLOC/1.0 (+https://fafa888.uk)',
        },
        lookup: (_host, _opts, cb) => cb(null, record.address, record.family),
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode)
        ) {
          res.destroy();
          clearTimeout(timer);
          resolve({
            status: res.statusCode,
            body: '',
            location: res.headers.location,
          });
          return;
        }
        if (
          res.statusCode !== 200 ||
          (res.headers['content-encoding'] &&
            res.headers['content-encoding'] !== 'identity')
        ) {
          res.destroy();
          finish(Error('upstream'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            res.destroy();
            finish(Error('size'));
          } else chunks.push(chunk);
        });
        res.on('error', finish);
        res.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: 200,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', finish);
    req.end();
  });
}
export function locationTools(fetcher: MapFetch = mapFetch, now = Date.now) {
  const cache = new Map<string, { until: number; result: unknown }>();
  let active = 0,
    next = 0;
  async function limited<T>(operation: () => Promise<T>) {
    if (active || now() < next)
      throw new AppError(429, 'MAP_BUSY', '地图服务请求过于频繁，请稍后重试');
    active++;
    next = now() + 1100;
    try {
      return await operation();
    } finally {
      active--;
    }
  }
  return {
    async search(query: string) {
      if (process.env.WLOC_SEARCH_ENABLED === 'false')
        throw new AppError(
          503,
          'SEARCH_DISABLED',
          '地点搜索尚未启用，请使用地图选点或坐标',
        );
      const endpoint = validateUrl(
        process.env.WLOC_SEARCH_URL || 'https://photon.komoot.io/api/',
      );
      if (endpoint.search || endpoint.hash)
        throw new AppError(503, 'SEARCH_CONFIG', '地点搜索配置无效');
      endpoint.searchParams.set('q', query);
      endpoint.searchParams.set('limit', '6');
      const key = createHash('sha256')
        .update(endpoint.toString())
        .digest('hex');
      const cached = cache.get(key);
      if (cached && cached.until > now()) return cached.result;
      return limited(async () => {
        try {
          const response = await fetcher(endpoint.toString());
          if (response.status !== 200) throw Error('redirect');
          const data = JSON.parse(response.body);
          if (!Array.isArray(data.features)) throw Error('format');
          const results = data.features.slice(0, 6).flatMap((feature: any) => {
            try {
              if (feature.geometry?.type !== 'Point') return [];
              const [lon, lat] = feature.geometry.coordinates;
              if (typeof lat !== 'number' || typeof lon !== 'number') return [];
              const point = coordinate(lat, lon);
              const p = feature.properties || {};
              const label = [
                ...new Set(
                  [
                    p.name,
                    p.street,
                    p.housenumber,
                    p.city,
                    p.state,
                    p.country,
                  ].filter((v) => typeof v === 'string' && v.trim()),
                ),
              ]
                .join(' · ')
                .slice(0, 240);
              return label
                ? [{ ...point, name: label, coordinateSystem: 'WGS84' }]
                : [];
            } catch {
              return [];
            }
          });
          const result = {
            results,
            attribution: '© OpenStreetMap contributors · Photon',
          };
          if (cache.size >= 128) cache.delete(cache.keys().next().value!);
          cache.set(key, { until: now() + 600000, result });
          return result;
        } catch {
          throw new AppError(
            502,
            'SEARCH_UNAVAILABLE',
            '地点搜索服务暂不可用，请使用地图选点或坐标',
          );
        }
      });
    },
    async resolve(raw: string, system: CoordinateSystem | 'AUTO') {
      let url = mapUrl(raw);
      try {
        return parseMapLink(url.toString(), system);
      } catch (e) {
        if (!(e instanceof MapLinkError) || e.code !== 'EXPAND_REQUIRED')
          throw new AppError(400, 'MAP_LINK_INVALID', (e as Error).message);
      }
      return limited(async () => {
        try {
          for (let hop = 0; hop < 4; hop++) {
            const response = await fetcher(url.toString());
            if (
              ![301, 302, 303, 307, 308].includes(response.status) ||
              !response.location
            )
              break;
            url = mapUrl(new URL(response.location, url).toString());
            try {
              return parseMapLink(url.toString(), system);
            } catch (e) {
              if (!(e instanceof MapLinkError) || e.code !== 'EXPAND_REQUIRED')
                throw e;
            }
          }
        } catch (e) {
          if (
            e instanceof MapLinkError &&
            e.code === 'COORDINATE_SYSTEM_REQUIRED'
          )
            throw new AppError(400, e.code, e.message);
        }
        throw new AppError(
          400,
          'MAP_LINK_UNRESOLVED',
          '短链接未能安全解析，请复制含坐标的长链接或手工输入坐标',
        );
      });
    },
  };
}
export async function registerLocationTools(
  app: FastifyInstance,
  tools = locationTools(),
) {
  const options = {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  };
  app.get('/api/location-tools/search', options, async (req) => {
    const { q } = z
      .object({ q: z.string().trim().min(2).max(160) })
      .parse(req.query);
    return tools.search(q);
  });
  app.get('/api/location-tools/resolve', options, async (req) => {
    const { url, system } = z
      .object({
        url: z.string().max(4096),
        system: z
          .enum(['AUTO', 'WGS84', 'GCJ02', 'BD09', 'BD09MC'])
          .default('AUTO'),
      })
      .parse(req.query);
    try {
      return await tools.resolve(url, system);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        400,
        'MAP_LINK_INVALID',
        '链接格式或坐标系无效，请检查后重试',
      );
    }
  });
}

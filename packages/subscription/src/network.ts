import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { AppError } from '../../shared/src';
export function publicAddress(address: string) {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolvePublic(host: string) {
  const records = await lookup(host.replace(/^\[|\]$/g, ''), {
    all: true,
    verbatim: true,
  });
  if (!records.length || records.some((r) => !publicAddress(r.address)))
    throw new AppError(400, 'SSRF_BLOCKED', '目标地址不符合公网访问策略');
  return records[0];
}
export function validateUrl(raw: string) {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    (u.port && u.port !== '443') ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new AppError(
      400,
      'URL_BLOCKED',
      '订阅仅接受不带认证信息的 HTTPS / 443 链接',
    );
  return u;
}
export async function safeFetch(
  raw: string,
  headers: Record<string, string> = {},
) {
  const u = validateUrl(raw);
  const record = await resolvePublic(u.hostname);
  return new Promise<{
    status: number;
    body: string;
    etag?: string;
    modified?: string;
  }>((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: 'GET',
        headers: {
          ...headers,
          'accept-encoding': 'identity',
          'user-agent': 'FAFA-One/0.1',
        },
        lookup: (_host, _opts, cb) => cb(null, record.address, record.family),
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 304) {
          res.destroy();
          reject(
            new AppError(502, 'UPSTREAM_ERROR', '上游拒绝请求或返回重定向'),
          );
          return;
        }
        if (
          res.headers['content-encoding'] &&
          res.headers['content-encoding'] !== 'identity'
        ) {
          res.destroy();
          reject(new AppError(400, 'ENCODING_BLOCKED', '不接受压缩订阅'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.destroy();
            reject(new AppError(400, 'TOO_LARGE', '订阅超过 1 MiB 限制'));
          } else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString('utf8'),
            etag: res.headers.etag,
            modified: res.headers['last-modified'],
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('上游请求超时')));
    req.on('error', reject);
    req.end();
  });
}

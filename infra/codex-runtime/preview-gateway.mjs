import { createServer, request } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const [root] = process.argv.slice(2);
if (
  !root?.startsWith('/opt/fafa-one/development/') ||
  process.env.NODE_ENV !== 'development'
) {
  throw Error('Private development preview directory required');
}
const contentTypes = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};
for (const [app, port] of [
  ['web', 39220],
  ['admin', 39221],
]) {
  const s = createServer(async (req, res) => {
    if (req.headers.host !== '127.0.0.1:' + port)
      return res.writeHead(403).end();
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (/^\/(api|auth|subscription)(\/|$)/.test(path)) {
      const upstream = request(
        {
          socketPath: join(root, 'api.sock'),
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return res.writeHead(405).end();
    const file = /^\/assets\/[A-Za-z0-9_.-]+$/.test(path)
      ? path.slice(1)
      : 'index.html';
    try {
      const target = join(root, app, file);
      if (!(await stat(target)).isFile()) return res.writeHead(404).end();
      res.writeHead(200, {
        'content-type':
          contentTypes[file.split('.').at(-1)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else
        createReadStream(target)
          .on('error', () => res.destroy())
          .pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  s.listen(join(root, app + '.sock'));
}

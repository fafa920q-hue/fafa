import { assertRuntimeDatabaseRole } from '../../../infra/scripts/check-runtime-db';
import { buildApp } from './server';
import { assertEnvironment } from '../../../packages/auth/src';
assertEnvironment();
await assertRuntimeDatabaseRole();
const app = await buildApp();
const previewSocket = process.env.API_PREVIEW_SOCKET;
if (
  previewSocket &&
  (process.env.NODE_ENV !== 'development' || !previewSocket.startsWith('/'))
)
  throw Error('预览 Socket 仅限本机开发环境');
await app.listen(
  previewSocket
    ? { path: previewSocket }
    : {
        port: Number(process.env.API_PORT || 4000),
        host: '0.0.0.0',
      },
);
console.log('FAFA ONE API 已启动');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });

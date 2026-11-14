import { readFile, lstat } from 'node:fs/promises';
import { parse } from 'dotenv';
import { assertPublicUrls } from '../../packages/auth/src/urls';
const path = process.env.FAFA_ENV_FILE || '/config/.env.production';
try {
  const metadata = await lstat(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
    throw Error('permissions');
  const raw = parse(await readFile(path));
  const env = { ...raw, ...process.env } as Record<string, string>;
  if (
    raw.NODE_ENV !== 'production' ||
    raw.DEMO_MODE !== 'false' ||
    raw.DEV_MOCK_LOGIN !== 'false'
  )
    throw Error('production flags');
  Object.assign(process.env, env);
  assertPublicUrls();
  if (
    (env.PANEL_DOMAIN || 'fafa888.uk') !== 'fafa888.uk' ||
    (env.ADMIN_DOMAIN || 'a.fafa888.uk') !== 'a.fafa888.uk' ||
    !['', 'fafa888.uk', '.fafa888.uk'].includes(
      (env.COOKIE_DOMAIN || '').toLowerCase(),
    )
  )
    throw Error('proxy or cookie domain');
  for (const name of [
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ])
    if (!env[name]) throw Error('required configuration');
  const database = new URL(env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.username ||
    !database.password ||
    decodeURIComponent(database.username) !== 'fafa' ||
    decodeURIComponent(database.password) !== env.POSTGRES_PASSWORD ||
    database.hostname !== 'postgres' ||
    !['', '5432'].includes(database.port) ||
    database.pathname !== '/fafa'
  )
    throw Error('database config');
  if (Buffer.from(env.ENCRYPTION_KEY, 'base64').length !== 32)
    throw Error('encryption key');
  let history = '';
  for await (const chunk of process.stdin) {
    history += chunk;
    if (Buffer.byteLength(history) > 64 * 1024 * 1024)
      throw Error('history scan limit');
  }
  const previous = JSON.parse(env.ENCRYPTION_PREVIOUS_KEYS_JSON || '{}');
  const secrets = [
    env.POSTGRES_PASSWORD,
    env.ENCRYPTION_KEY,
    env.GOOGLE_CLIENT_SECRET,
    ...Object.values(previous),
  ];
  if (
    secrets.some(
      (value) =>
        typeof value === 'string' &&
        value.length >= 16 &&
        history.includes(value),
    )
  )
    throw Error('current credential appears in tracked history');
  console.log(
    JSON.stringify({
      productionFlags: true,
      permissions600: true,
      publicUrls: true,
      currentSecretsAbsentFromGitHistory: true,
    }),
  );
} catch {
  console.error(
    '生产配置审计失败（未输出任何配置值）：复核权限、必需字段和历史泄露；仅对已确认泄露的凭据按轮换手册处理。',
  );
  process.exitCode = 1;
}

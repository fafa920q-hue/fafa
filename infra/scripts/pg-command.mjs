// Keep database URLs and passwords out of subprocess arguments.
import process from 'node:process';
import { URL } from 'node:url';
import { spawnSync } from 'node:child_process';
const [variable, command, ...args] = process.argv.slice(2);
if (
  !['DATABASE_URL', 'RESTORE_DATABASE_URL'].includes(variable) ||
  !['pg_dump', 'pg_restore', 'psql'].includes(command)
)
  throw Error('不支持的数据库工具调用');
const url = new URL(process.env[variable] || '');
if (!['postgres:', 'postgresql:'].includes(url.protocol))
  throw Error('需要 PostgreSQL URL');
const env = {
  ...process.env,
  PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
};
const options = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
};
for (const [key, value] of url.searchParams) {
  if (!(key in options)) throw Error('数据库 URL 含有工具尚未支持的参数');
  env[options[key]] = value;
}
const result = spawnSync(command, ['--dbname=' + env.PGDATABASE, ...args], {
  env,
  stdio: 'inherit',
});
if (result.error) throw Error('无法启动 PostgreSQL 客户端工具');
process.exit(result.status ?? 1);

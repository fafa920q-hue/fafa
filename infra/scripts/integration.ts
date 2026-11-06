import 'dotenv/config';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
const url = new URL(
  process.env.TEST_DATABASE_URL ||
    'postgres://fafa:fafa_dev_only@localhost:5432/fafa_test',
);
const name = url.pathname.slice(1);
if (!name.endsWith('_test')) throw Error('测试数据库名称必须以 _test 结尾');
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString());
if (
  !(await admin`select datname from pg_database where datname=${name}`).length
)
  await admin`create database ${admin(name)}`;
await admin.end();
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  TEST_DATABASE_URL: url.toString(),
};
for (const args of [
  ['exec', 'tsx', 'packages/db/src/migrate.ts'],
  ['exec', 'vitest', 'run', 'tests/integration.test.ts'],
]) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env });
  if (result.status) process.exit(result.status);
}

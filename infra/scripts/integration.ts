import 'dotenv/config';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
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
  ['exec', 'vitest', 'run', 'tests/integration.test.ts', 'tests/wloc.integration.test.ts'],
]) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env });
  if (result.status) process.exit(result.status);
}

const ownerUrl = new URL(url);
const ownerDatabase = 'fafa_owner_' + randomBytes(6).toString('hex') + '_test';
ownerUrl.pathname = '/' + ownerDatabase;
const ownerAdmin = postgres(adminUrl.toString());
await ownerAdmin`create database ${ownerAdmin(ownerDatabase)}`;
try {
  for (const args of [
    ['exec', 'tsx', 'packages/db/src/migrate.ts'],
    ['exec', 'vitest', 'run', 'tests/owner.integration.test.ts'],
  ]) {
    const result = spawnSync('pnpm', args, {
      stdio: 'inherit',
      env: {
        ...env,
        DATABASE_URL: ownerUrl.toString(),
        TEST_DATABASE_URL: ownerUrl.toString(),
      },
    });
    if (result.status) throw Error('Owner 隔离测试失败');
  }
} finally {
  await ownerAdmin`drop database ${ownerAdmin(ownerDatabase)}`;
  await ownerAdmin.end();
}

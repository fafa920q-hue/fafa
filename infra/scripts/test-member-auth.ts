import 'dotenv/config';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const target = new URL(
  process.env.TEST_DATABASE_URL ||
    'postgres://fafa:fafa_dev_only@localhost:5432/fafa_test',
);
if (
  !['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
  !target.pathname.endsWith('_test')
)
  throw Error('普通账户测试仅允许本机 _test 数据库；不访问生产');
const adminUrl = new URL(target);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString());
const name = 'fafa_member_' + randomBytes(6).toString('hex') + '_test';
target.pathname = '/' + name;
await admin.unsafe('CREATE DATABASE "' + name + '"');
try {
  for (const args of [
    ['exec', 'tsx', 'packages/db/src/migrate.ts'],
    [
      'exec',
      'vitest',
      'run',
      'tests/member-auth.unit.test.ts',
      'tests/member-auth.integration.test.ts',
      'tests/member-auth.upgrade.test.ts',
      'tests/member-mail-acceptance.test.ts',
      'tests/mail-secret.test.ts',
    ],
  ]) {
    const result = spawnSync('pnpm', args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: target.toString(),
        TEST_DATABASE_URL: target.toString(),
      },
    });
    if (result.status !== 0) throw Error('普通账户测试失败');
  }
} finally {
  await admin.unsafe('DROP DATABASE "' + name + '" WITH (FORCE)');
  await admin.end();
}

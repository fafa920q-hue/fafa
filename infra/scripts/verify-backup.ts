import 'dotenv/config';
import postgres from 'postgres';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { seal, unseal } from '../../packages/shared/src/crypto';
const configured = new URL(
  process.env.TEST_DATABASE_URL ||
    'postgres://fafa:fafa_dev_only@localhost:5432/fafa_test',
);
if (!configured.pathname.endsWith('_test'))
  throw Error('恢复演练只允许测试数据库连接配置');
const adminUrl = new URL(configured);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString());
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const names = [`fafa_backup_${suffix}_test`, `fafa_restored_${suffix}_test`];
const urls = names.map((name) => {
  const url = new URL(configured);
  url.pathname = '/' + name;
  return url.toString();
});
const temporary = await mkdtemp(join(tmpdir(), 'fafa-backup-'));
const identity = join(temporary, 'age-identity');
const created: string[] = [];
const clients: ReturnType<typeof postgres>[] = [];
function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  expectSuccess = true,
) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (expectSuccess && result.status !== 0)
    throw Error(
      `${command} 执行失败：${result.stderr.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[数据库连接已脱敏]').replace(/AGE-SECRET-KEY-[A-Z0-9]+/g, '[私钥已脱敏]')}`,
    );
  return result;
}
try {
  for (const name of names) {
    await admin`create database ${admin(name)}`;
    created.push(name);
  }
  run('node', ['--import', 'tsx', 'packages/db/src/migrate.ts'], {
    ...process.env,
    DATABASE_URL: urls[0],
  });
  const source = postgres(urls[0]);
  const target = postgres(urls[1]);
  clients.push(source, target);
  const [user] =
    await source`insert into users(email,name,role) values('backup-fixture@example.invalid','恢复演练用户','Member') returning id`;
  const secret = 'backup-test-fixture-not-a-real-credential';
  await source`insert into ai_accounts(owner_id,data,secret) values(${user.id},${source.json({ name: '加密恢复测试', status: 'UNVERIFIED' })},${source.json(seal(secret))})`;
  await source`insert into audit_events(owner_id,action) values(${user.id},'backup.fixture_created')`;
  run('age-keygen', ['-o', identity]);
  const recipient = run('age-keygen', ['-y', identity]).stdout.trim();
  run('bash', ['infra/scripts/backup.sh'], {
    ...process.env,
    DATABASE_URL: urls[0],
    AGE_RECIPIENT: recipient,
    BACKUP_DIRECTORY: temporary,
  });
  const backup = join(
    temporary,
    (await readdir(temporary)).find((file) => file.endsWith('.dump.age'))!,
  );
  const encrypted = await readFile(backup);
  assert(encrypted.toString().startsWith('age-encryption.org/v1'));
  assert(!encrypted.includes(Buffer.from(secret)));
  const restoreEnv = {
    ...process.env,
    RESTORE_DATABASE_URL: urls[1],
    AGE_IDENTITY_FILE: identity,
    CONFIRM_RESTORE: 'RESTORE_TO_NEW_DATABASE',
  };
  assert.notEqual(
    run(
      'bash',
      ['infra/scripts/restore.sh', backup],
      { ...restoreEnv, CONFIRM_RESTORE: '' },
      false,
    ).status,
    0,
  );
  run('bash', ['infra/scripts/restore.sh', backup], restoreEnv);
  const [restoredUser] = await target`select * from users where id=${user.id}`;
  assert.equal(restoredUser.name, '恢复演练用户');
  const [credential] =
    await target`select secret from ai_accounts where owner_id=${user.id}`;
  assert.equal(unseal(credential.secret), secret);
  const tables =
    await source`select tablename from pg_tables where schemaname='public' order by tablename`;
  for (const { tablename } of tables) {
    const [before] =
      await source`select count(*)::int as n from ${source(tablename)}`;
    const [after] =
      await target`select count(*)::int as n from ${target(tablename)}`;
    assert.equal(after.n, before.n, tablename);
  }
  const audit = await target`select id from audit_events limit 1`;
  await assert.rejects(
    target`update audit_events set action='tamper' where id=${audit[0].id}`,
  );
  assert.notEqual(
    run('bash', ['infra/scripts/restore.sh', backup], restoreEnv, false).status,
    0,
    '非空数据库必须拒绝恢复',
  );
  await mkdir('docs/evidence', { recursive: true });
  await writeFile(
    resolve('docs/evidence/backup-restore.json'),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        scope: '独立一次性测试数据库；没有访问生产',
        encryptedBackup: true,
        encryption: 'age',
        sha256: createHash('sha256').update(encrypted).digest('hex'),
        tablesCompared: tables.length,
        credentialsDecrypted: true,
        auditAppendOnly: true,
        nonEmptyRestoreBlocked: true,
        explicitConfirmationRequired: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `加密备份与实际恢复通过：${tables.length} 张表计数一致、凭据可解密、审计不可篡改、非空库恢复被拒绝`,
  );
} finally {
  for (const client of clients) await client.end();
  for (const name of created) await admin`drop database ${admin(name)}`;
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}

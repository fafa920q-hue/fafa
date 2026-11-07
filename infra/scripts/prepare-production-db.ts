import { randomBytes, pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import postgres from 'postgres';
import { parse } from 'dotenv';
let connection: ReturnType<typeof postgres> | undefined;
const path = process.env.FAFA_RUNTIME_FILE || '/config/.env.runtime';
const role = process.env.FAFA_TEST_RUNTIME_ROLE || 'fafa_app';
const ddl = (tx: any, statement: string) =>
  tx.unsafe(statement.replaceAll('fafa_app', role));
let created = false;
try {
  if (
    role !== 'fafa_app' &&
    (!/^fafa_test_[0-9a-f]{12}$/.test(role) ||
      !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'))
  )
    throw Error('测试角色仅允许隔离测试数据库');
  const admin = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: () => {},
  });
  connection = admin;
  let config: Record<string, string> | undefined;
  try {
    if (((await stat(path)).mode & 0o777) !== 0o600)
      throw Error('runtime config permissions');
    config = parse(await readFile(path));
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const existing =
    await admin`select rolname from pg_roles where rolname=${role}`;
  if (!!existing.length !== !!config)
    throw Error('existing runtime role and file must agree');
  const runtimeUrl = new URL(process.env.DATABASE_URL!);
  if (config) {
    const stored = new URL(config.DATABASE_URL);
    if (
      stored.username !== role ||
      stored.hostname !== runtimeUrl.hostname ||
      stored.pathname !== runtimeUrl.pathname ||
      stored.port !== runtimeUrl.port
    )
      throw Error('runtime target mismatch');
    const check = postgres(stored.toString(), { max: 1 });
    try {
      await check`select 1`;
    } finally {
      await check.end();
    }
  } else {
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
    const client = createHmac('sha256', salted).update('Client Key').digest();
    const stored = createHash('sha256').update(client).digest('base64');
    const server = createHmac('sha256', salted)
      .update('Server Key')
      .digest('base64');
    const verifier =
      'SCRAM-SHA-256$4096:' +
      salt.toString('base64') +
      '$' +
      stored +
      ':' +
      server;
    await admin.begin(async (tx) => {
      await ddl(
        tx,
        "CREATE ROLE fafa_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '" +
          verifier +
          "'",
      );
      runtimeUrl.username = role;
      runtimeUrl.password = password;
      await writeFile(
        path,
        'DATABASE_URL=' + JSON.stringify(runtimeUrl.toString()) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      created = true;
    });
  }
  if (!process.argv.includes('--identity-only')) {
    await admin.begin(async (tx) => {
      await ddl(
        tx,
        'ALTER ROLE fafa_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
      );
      await ddl(tx, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await ddl(tx, 'GRANT USAGE ON SCHEMA public TO fafa_app');
      const [database] = await tx`select current_database() as name`;
      await tx`grant connect on database ${tx(database.name)} to ${tx(role)}`;
      const tables = [
        'users',
        'google_identities',
        'sessions',
        'settings',
        'invitations',
        'roles',
        'permissions',
        'user_role_grants',
        'node_sources',
        'nodes',
        'node_groups',
        'node_group_grants',
        'subscription_profiles',
        'subscription_tokens',
        'subscription_sync_runs',
        'node_health_checks',
        'traffic_usage_samples',
        'ai_accounts',
        'ai_tasks',
        'ai_sessions',
        'server_connections',
        'server_access_grants',
        'ssh_sessions',
        'location_presets',
        'background_jobs',
      ];
      for (const table of tables)
        await tx`grant select,insert,update,delete on ${tx(table)} to ${tx(role)}`;
      for (const table of [
        'member_credentials',
        'member_registrations',
        'member_action_tokens',
        'member_auth_buckets',
        'member_google_links',
      ])
        await tx.unsafe(
          'GRANT SELECT,INSERT,UPDATE ON ' + table + ' TO ' + role,
        );
      await ddl(tx, 'GRANT SELECT,INSERT ON audit_events TO fafa_app');
      await ddl(
        tx,
        'REVOKE UPDATE,DELETE,TRUNCATE ON audit_events FROM fafa_app',
      );
      await ddl(
        tx,
        'REVOKE ALL ON owner_setup_credentials,owner_initialization,migrations FROM fafa_app',
      );
      await ddl(
        tx,
        'GRANT EXECUTE ON FUNCTION owner_setup_available(),begin_owner_setup(uuid,text,text),complete_owner_setup(uuid,text,text,text,text),owner_identity_allowed(text) TO fafa_app',
      );
    });
  }
  console.log(
    JSON.stringify({
      runtimeRole: role,
      prepared: true,
      newRuntimeCredential: created,
      existingProductionSecretsChanged: false,
    }),
  );
} catch {
  console.error(
    '数据库最小权限准备失败；未打印凭据。检查既有管理员权限、runtime 文件一致性与迁移结果，勿覆盖现有配置。',
  );
  process.exitCode = 1;
} finally {
  await connection?.end();
}

import { it, expect } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

it('005 增量迁移保留既有 Owner、Google sub、会话、设置和加密数据，并可重复执行迁移入口', async () => {
  const current = new URL(process.env.TEST_DATABASE_URL!);
  if (
    !['localhost', '127.0.0.1'].includes(current.hostname) ||
    !current.pathname.endsWith('_test')
  )
    throw Error('迁移兼容测试仅允许本机测试数据库');
  const name = 'fafa_upgrade_' + randomBytes(6).toString('hex') + '_test';
  const adminUrl = new URL(current);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString());
  await admin.unsafe('CREATE DATABASE "' + name + '"');
  current.pathname = '/' + name;
  const db = postgres(current.toString(), { max: 1, onnotice: () => {} });
  const ownerId = randomUUID();
  const sourceId = randomUUID();
  const sessionHash = randomBytes(32).toString('hex');
  const opaqueCipher = {
    ciphertext: 'synthetic-already-encrypted-content',
    keyId: 'synthetic-existing-key',
  };
  const apply = async (migration: string) =>
    db.begin(async (tx) => {
      await tx.unsafe('SELECT pg_advisory_xact_lock(77701)');
      const exists = await tx.unsafe(
        'SELECT name FROM migrations WHERE name=$1',
        [migration],
      );
      if (!exists.length) {
        await tx.unsafe(
          await readFile(
            new URL('../packages/db/migrations/' + migration, import.meta.url),
            'utf8',
          ),
        );
        await tx.unsafe('INSERT INTO migrations(name) VALUES($1)', [migration]);
      }
    });
  try {
    await db.unsafe(
      'CREATE TABLE migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())',
    );
    await apply('001_initial.sql');
    await apply('002_limits.sql');
    await db.unsafe(
      "INSERT INTO users(id,email,name,role) VALUES($1,'existing-owner@example.invalid','Existing Owner','Owner')",
      [ownerId],
    );
    await db.unsafe(
      "INSERT INTO google_identities(user_id,sub) VALUES($1,'existing-google-sub')",
      [ownerId],
    );
    await db.unsafe(
      "INSERT INTO sessions(owner_id,token_hash,csrf,expires_at) VALUES($1,$2,'synthetic-csrf',now()+interval '1 day')",
      [ownerId, sessionHash],
    );
    await db.unsafe(
      "INSERT INTO node_sources(id,owner_id,data,secret) VALUES($1,$2,'{}',$3::jsonb)",
      [sourceId, ownerId, opaqueCipher as any],
    );
    await db.unsafe("UPDATE settings SET value='17' WHERE key='seat_limit'");
    await apply('003_owner_setup.sql');
    await apply('004_traffic_policy.sql');
    await apply('005_member_auth.sql');
    await apply('006_auto_grant_policy.sql');
    await apply('007_member_delivery.sql');
    await apply('005_member_auth.sql');
    await apply('006_auto_grant_policy.sql');
    await apply('007_member_delivery.sql');
    const [owner] = await db.unsafe(
      'SELECT id,role,disabled,deleted_at FROM users WHERE id=$1',
      [ownerId],
    );
    expect(owner).toMatchObject({
      id: ownerId,
      role: 'Owner',
      disabled: false,
      deleted_at: null,
    });
    const [binding] = await db.unsafe(
      'SELECT owner_id,google_sub,closed FROM owner_initialization WHERE singleton',
    );
    expect(binding).toMatchObject({
      owner_id: ownerId,
      google_sub: 'existing-google-sub',
      closed: true,
    });
    const [session] = await db.unsafe(
      'SELECT token_hash,revoked_at FROM sessions WHERE owner_id=$1',
      [ownerId],
    );
    expect(session).toMatchObject({
      token_hash: sessionHash,
      revoked_at: null,
    });
    const [source] = await db.unsafe(
      'SELECT secret FROM node_sources WHERE id=$1',
      [sourceId],
    );
    expect(source.secret).toEqual(opaqueCipher);
    const [limit] = await db.unsafe(
      "SELECT value FROM settings WHERE key='seat_limit'",
    );
    expect(limit.value).toBe(17);
    const [policy] = await db.unsafe(
      "SELECT value FROM settings WHERE key='member_registration_open'",
    );
    expect(policy.value).toBe(false);
    expect(
      await db.unsafe('SELECT user_id FROM member_credentials'),
    ).toHaveLength(0);
  } finally {
    await db.end();
    await admin.unsafe('DROP DATABASE "' + name + '" WITH (FORCE)');
    await admin.end();
  }
});

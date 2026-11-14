import 'dotenv/config';
import { sql, audit } from '../../packages/db/src';
import { unseal, seal } from '../../packages/shared/src/crypto';
const tables = ['node_sources', 'nodes', 'ai_accounts', 'server_connections'];
for (const table of tables) {
  const rows =
    await sql`select id,secret from ${sql(table)} where secret is not null`;
  const changes = rows.filter(
    (r) => r.secret.keyId !== process.env.ENCRYPTION_KEY_ID,
  );
  for (const row of changes) unseal(row.secret);
  if (process.env.APPLY_KEY_ROTATION === 'true') {
    await sql.begin(async (tx) => {
      for (const row of changes)
        await tx`update ${sql(table)} set secret=${tx.json(seal(unseal(row.secret)))},updated_at=now() where id=${row.id}`;
    });
  }
  console.log(
    `${table}: ${changes.length} 项${process.env.APPLY_KEY_ROTATION === 'true' ? '已轮换' : '可轮换（dry run）'}`,
  );
}
if (process.env.APPLY_KEY_ROTATION === 'true')
  await audit(null, 'encryption.keys_rotated');
await sql.end();

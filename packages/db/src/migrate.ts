import { readFile } from 'node:fs/promises';
import { sql } from './index';
await sql`create table if not exists migrations (name text primary key, applied_at timestamptz default now())`;
for (const name of [
  '001_initial.sql',
  '002_limits.sql',
  '003_owner_setup.sql',
  '004_traffic_policy.sql',
  '006_auto_grant_policy.sql',
]) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(77701)`;
    if (!(await tx`select name from migrations where name=${name}`).length) {
      await tx.unsafe(
        await readFile(
          new URL('../migrations/' + name, import.meta.url),
          'utf8',
        ),
      );
      await tx`insert into migrations(name) values(${name})`;
    }
  });
}
await sql.end();
console.log('数据库迁移完成');

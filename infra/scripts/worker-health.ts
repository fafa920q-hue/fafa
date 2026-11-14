import { sql } from '../../packages/db/src';
const [r] =
  await sql`select updated_at>now()-interval '30 seconds' as healthy from settings where key='worker_heartbeat'`;
await sql.end();
if (!r?.healthy) process.exit(1);

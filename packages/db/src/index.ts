import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
export const sql = postgres(
  process.env.DATABASE_URL ||
    'postgres://fafa:fafa_dev_only@localhost:5432/fafa',
  { max: 8, onnotice: () => {} },
);
// Drizzle customizes JSON serializers; keep its client separate from tagged raw SQL.
export const ormSql = postgres(
  process.env.DATABASE_URL ||
    'postgres://fafa:fafa_dev_only@localhost:5432/fafa',
  { max: 2 },
);
export const db = drizzle(ormSql, { schema });
export async function audit(
  owner: string | null,
  action: string,
  target: string | null = null,
  correlation: string | null = null,
) {
  await sql`insert into audit_events(owner_id,action,target_id,correlation_id) values (${owner},${action},${target},${correlation})`;
}
export const resourceTables = [
  'node_sources',
  'ai_accounts',
  'server_connections',
  'location_presets',
] as const;
export type ResourceTable = (typeof resourceTables)[number];
export async function own(table: ResourceTable, id: string, owner: string) {
  const [row] =
    await sql`select * from ${sql(table)} where id=${id} and owner_id=${owner} and revoked_at is null`;
  return row;
}

import { sql } from '../../packages/db/src';
export async function assertRuntimeDatabaseRole(expectedRole = 'fafa_app') {
  if (process.env.NODE_ENV !== 'production') return;
  const [role] = await sql`select current_user as name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=current_user`;
  const [permissions] = await sql`select
    has_table_privilege(current_user,'owner_setup_credentials','SELECT,INSERT,UPDATE,DELETE') as setup_access,
    has_table_privilege(current_user,'owner_initialization','INSERT,UPDATE,DELETE') as binding_access,
    has_table_privilege(current_user,'audit_events','UPDATE,DELETE') as audit_write,
    has_schema_privilege(current_user,'public','CREATE') as ddl`;
  if (role.name!==expectedRole || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolbypassrls ||
    permissions.setup_access || permissions.binding_access || permissions.audit_write || permissions.ddl)
    throw Error('生产 API/Worker 必须使用已加固的 fafa_app 数据库角色');
}

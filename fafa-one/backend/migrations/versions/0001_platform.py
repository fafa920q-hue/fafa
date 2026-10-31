"""v1 schema; imports a legacy v0.3 users table without keeping old sessions."""
from alembic import op
import sqlalchemy as sa
from app.models import Base
revision = '0001_platform'
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    conn = op.get_bind()
    legacy = 'users' in sa.inspect(conn).get_table_names()
    if legacy:
        op.rename_table('users', 'legacy_v03_users')
    # Freeze the original revision's inventory. Importing current metadata must not
    # accidentally create future tables when a fresh DB runs this old migration.
    original = {'roles','users','sessions','auth_tokens','oauth_flows','oauth_identities',
        'rate_buckets','audit_logs','security_lock','settings','nodes','node_versions',
        'node_operations','ai_accounts','ai_models','ai_requests','projects','tasks'}
    Base.metadata.create_all(conn, tables=[t for t in Base.metadata.sorted_tables if t.name in original])
    roles = Base.metadata.tables['roles']
    conn.execute(roles.insert(), [{'name':'super_admin','modules':['nodes','ai','codex']}, {'name':'user','modules':[]}])
    conn.execute(Base.metadata.tables['security_lock'].insert(), {'id':1, 'value':0})
    if legacy:
        # Unknown legacy roles are deliberately reduced to ordinary users.
        conn.execute(sa.text("""INSERT INTO users(id,email,display_name,password_hash,role,active,verified,grants,monthly_requests,monthly_tokens,budget_cents,created_at)
        SELECT id,lower(email),display_name,password_hash,CASE WHEN role='super_admin' THEN 'super_admin' ELSE 'user' END,active,:verified,:grants,100,100000,1000,created_at FROM legacy_v03_users"""), {'verified':False,'grants':'{}'})
        op.drop_table('legacy_v03_users')
        if conn.dialect.name == 'postgresql':
            conn.execute(sa.text("SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users),1), EXISTS(SELECT 1 FROM users))"))

def downgrade():
    raise RuntimeError('Restore a verified backup for rollback; destructive schema downgrade is disabled')

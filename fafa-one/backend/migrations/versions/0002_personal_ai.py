"""Add personal AI data without altering or deleting any archived v1 business rows.

This is not a migration for the uninspected production FAFA CONTROL database.
"""
from alembic import op
from app.models import Base

revision = '0002_personal_ai'
down_revision = '0001_platform'
branch_labels = None
depends_on = None


def upgrade():
    names = {'ai_connections', 'chat_sessions', 'chat_messages', 'ai_runs'}
    for table in Base.metadata.sorted_tables:
        if table.name in names:
            table.create(op.get_bind(), checkfirst=False)


def downgrade():
    raise RuntimeError('Preserve personal data; restore a verified pre-migration backup instead')

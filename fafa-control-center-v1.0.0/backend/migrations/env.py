from alembic import context
from app.database import engine
from app.models import Base
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=engine.dialect.name == 'sqlite')
    with context.begin_transaction():
        context.run_migrations()

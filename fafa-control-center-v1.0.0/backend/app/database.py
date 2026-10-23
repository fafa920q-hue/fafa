from contextlib import contextmanager
from pathlib import Path
from sqlalchemy import create_engine, event, update
from sqlalchemy.orm import sessionmaker
from .config import settings
from .models import Lock

args = {'check_same_thread': False, 'timeout': 30} if settings.database_url.startswith('sqlite') else {}
engine = create_engine(settings.database_url, connect_args=args, pool_pre_ping=True)
if settings.database_url.startswith('sqlite'):
    @event.listens_for(engine, 'connect')
    def sqlite_pragmas(conn, _):
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute('PRAGMA busy_timeout=30000')
SessionLocal = sessionmaker(engine, expire_on_commit=False)

@contextmanager
def transaction():
    with SessionLocal.begin() as session:
        yield session

def serialize_security(session):
    # A real write lock serializes bootstrap, demotion, disable, budgets and queue claims
    # on both PostgreSQL (row lock) and SQLite (writer lock).
    session.execute(update(Lock).where(Lock.id == 1).values(value=Lock.value + 1))

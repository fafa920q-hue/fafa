import os,secrets,tempfile
from pathlib import Path
import pytest

TEST_ROOT=Path(tempfile.mkdtemp(prefix='fafa-tests-'))
if os.getenv('FAFA_TEST_DATABASE_URL'):
    from sqlalchemy.engine import make_url
    target=make_url(os.environ['FAFA_TEST_DATABASE_URL'])
    if target.host not in ('127.0.0.1','localhost') or target.database!='fafa_test' or not target.drivername.startswith('postgresql'):
        raise RuntimeError('Tests only accept the disposable loopback PostgreSQL fafa_test database')
os.environ.update(APP_ENV='development',APP_SECRET=secrets.token_urlsafe(48),COOKIE_SECURE='false',PUBLIC_ORIGIN='http://testserver',
                  REQUIRE_VERIFIED_EMAIL='false',DATABASE_URL=os.getenv('FAFA_TEST_DATABASE_URL','sqlite:///'+str(TEST_ROOT/'app.db')))
from alembic.config import Config
from alembic import command
from fastapi.testclient import TestClient
from app.main import app
from app.database import engine,transaction
from app.models import Base,Role,Lock,User
from app.bootstrap import bootstrap
from app.security import hash_password

@pytest.fixture(scope='session',autouse=True)
def schema():
    command.upgrade(Config(str(Path(__file__).parents[1]/'alembic.ini')),'head')
    yield
    if engine.dialect.name == 'postgresql':
        with engine.begin() as c:
            Base.metadata.drop_all(c)
            from sqlalchemy import text
            c.execute(text('DROP TABLE IF EXISTS alembic_version'))
    engine.dispose()
    import shutil
    shutil.rmtree(TEST_ROOT)

@pytest.fixture(autouse=True)
def clean(schema):
    with engine.begin() as c:
        for table in reversed(Base.metadata.sorted_tables):c.execute(table.delete())
        c.execute(Role.__table__.insert(),[{'name':'super_admin','modules':['nodes','ai','codex']},{'name':'user','modules':[]}])
        c.execute(Lock.__table__.insert(),{'id':1,'value':0})

@pytest.fixture
def client():
    with TestClient(app) as c:
        c.headers['X-CSRF-Token']=c.get('/api/v1/auth/csrf').json()['csrf_token']
        yield c

@pytest.fixture
def admin(client):
    uid=bootstrap('root@example.com','test-admin-password-123')
    assert client.post('/api/v1/auth/login',json={'email':'root@example.com','password':'test-admin-password-123'}).status_code==200
    return client

@pytest.fixture
def regular(client):
    r=client.post('/api/v1/auth/register',json={'email':'person@example.com','password':'test-person-password-123','display_name':'Person','role':'super_admin','is_admin':True,'permissions':['*']})
    assert r.status_code==200,r.text
    assert client.post('/api/v1/auth/login',json={'email':'person@example.com','password':'test-person-password-123'}).status_code==200
    return client

def create_user(email='other@example.com',role='user',modules=None,grants=None):
    with transaction() as s:
        u=User(email=email,display_name='Test user',password_hash=hash_password('test-user-password-123'),role=role,verified=True,grants=grants or {'modules':modules or []})
        s.add(u);s.flush();return u.id

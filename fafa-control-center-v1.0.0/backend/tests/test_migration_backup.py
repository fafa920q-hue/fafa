import os,sqlite3,subprocess,sys
from pathlib import Path
import pytest
ROOT=Path(__file__).resolve().parents[2]

def test_legacy_migration_preserves_user_and_drops_sessions(tmp_path):
    path=tmp_path/'legacy.db'
    with sqlite3.connect(path) as c:
        c.execute('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL,created_at INTEGER NOT NULL)')
        c.execute("INSERT INTO users VALUES(7,'test@example.com','TEST','TEST_HASH','user',1,1)")
    env=os.environ|{'DATABASE_URL':'sqlite:///'+str(path)}
    r=subprocess.run([sys.executable,'-m','alembic','-c',str(ROOT/'backend/alembic.ini'),'upgrade','head'],env=env,capture_output=True,text=True)
    assert r.returncode==0,r.stderr
    with sqlite3.connect(path) as c:
        assert c.execute('SELECT id,email,role,verified FROM users').fetchone()==(7,'test@example.com','user',0)
        assert c.execute('SELECT count(*) FROM sessions').fetchone()[0]==0
        assert c.execute('PRAGMA foreign_key_list(users)').fetchone()[2]=='roles'
        assert c.execute('PRAGMA foreign_key_check').fetchall()==[]

def test_backup_restore_checks(tmp_path):
    source=tmp_path/'source.db';backup=tmp_path/'backup.db';restored=tmp_path/'restored.db'
    with sqlite3.connect(source) as c:c.execute('CREATE TABLE test(value TEXT)');c.execute("INSERT INTO test VALUES('TEST')")
    for script,args in [('backup.py',[source,backup]),('restore.py',[backup,restored])]:
        r=subprocess.run([sys.executable,str(ROOT/'scripts'/script),*map(str,args)],capture_output=True,text=True)
        assert r.returncode==0,r.stderr
    with sqlite3.connect(restored) as c:assert c.execute('SELECT value FROM test').fetchone()[0]=='TEST'
    assert backup.stat().st_mode&0o777==0o600
    assert subprocess.run([sys.executable,str(ROOT/'scripts/restore.py'),str(backup),str(restored)],capture_output=True).returncode!=0

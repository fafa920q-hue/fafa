"""Archived v1 preservation, not a migration of the unavailable live database."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_populated_v1_to_v2_preserves_every_existing_table(tmp_path):
    path = tmp_path / "archived-v1.db"
    env = os.environ | {"DATABASE_URL": "sqlite:///" + str(path)}
    command = [sys.executable, "-m", "alembic", "-c", str(ROOT / "backend/alembic.ini"), "upgrade"]
    result = subprocess.run([*command, "0001_platform"], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT count(*) FROM sqlite_master WHERE name='ai_connections'").fetchone()[0] == 0
        db.execute(
            "INSERT INTO users VALUES(41,'legacy@example.com','Legacy','archived-password-hash','user',1,1,'{}',100,100000,1000,1)"
        )
        db.execute("INSERT INTO sessions VALUES('legacy-session-digest',41,2000000000,1)")
        db.execute("INSERT INTO ai_accounts VALUES(9,'Platform API','openai','legacy_secret_ref',1)")
        db.execute(
            "INSERT INTO nodes VALUES(19,'Old node','xray','legacy','region','{}','trusted_agent',1,'unknown',NULL,NULL,NULL,NULL,0)"
        )
        db.execute("INSERT INTO projects VALUES(21,41,'Old workspace','https://github.com/example/project',1)")
        tables = [
            r[0]
            for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('alembic_version','sqlite_sequence')"
            )
        ]
        snapshot = {t: db.execute("SELECT * FROM " + t).fetchall() for t in tables}
    result = subprocess.run([*command, "head"], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "0002_personal_ai"
        assert snapshot == {t: db.execute("SELECT * FROM " + t).fetchall() for t in tables}
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
        assert db.execute("SELECT count(*) FROM ai_connections").fetchone()[0] == 0

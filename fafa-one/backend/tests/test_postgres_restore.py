"""Actual pg_dump/pg_restore on an explicitly named disposable Docker database."""

import os
import subprocess
import uuid

import pytest
from conftest import create_user
from sqlalchemy import func, select

from app.database import transaction
from app.models import AIConnection, Base
from app.one import vault


def test_disposable_postgres_backup_restores_all_counts_and_encrypted_key():
    container = os.environ.get("FAFA_TEST_PG_CONTAINER", "")
    if not container.startswith("fafa-smoke-"):
        pytest.skip("PostgreSQL Docker restore check only runs in scripts/docker_smoke.sh")
    uid = create_user()
    with transaction() as s:
        c = AIConnection(owner_id=uid, name="Restore check", provider="openai", encrypted_key="")
        s.add(c)
        s.flush()
        cid = c.id
        c.encrypted_key = vault.seal("LOCAL-RESTORE-TEST-ONLY", uid, cid)
    with transaction() as s:
        counts = {
            table.name: s.scalar(select(func.count()).select_from(table)) for table in Base.metadata.sorted_tables
        }
    target = "restore_" + uuid.uuid4().hex[:12]
    backup = "/tmp/" + target + ".dump"

    def execute(*command):
        result = subprocess.run(
            ["docker", "--host=unix:///var/run/docker.sock", "exec", container, *command],
            text=True,
            capture_output=True,
            timeout=30,
        )
        assert result.returncode == 0, "Disposable PostgreSQL restore operation failed: " + command[0]
        return result.stdout.strip()

    try:
        execute("pg_dump", "-U", "fafa", "-d", "fafa_test", "-Fc", "-f", backup)
        execute("chmod", "600", backup)
        execute("createdb", "-U", "fafa", target)
        execute("pg_restore", "-U", "fafa", "-d", target, "--exit-on-error", backup)
        for name, count in counts.items():
            assert int(execute("psql", "-U", "fafa", "-d", target, "-tAc", "SELECT count(*) FROM " + name)) == count
        encrypted = execute(
            "psql", "-U", "fafa", "-d", target, "-tAc", f"SELECT encrypted_key FROM ai_connections WHERE id={cid}"
        )
        assert vault.unseal(encrypted, uid, cid) == "LOCAL-RESTORE-TEST-ONLY"
    finally:
        execute("dropdb", "--if-exists", "-U", "fafa", target)
        execute("rm", "-f", backup)

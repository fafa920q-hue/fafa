#!/usr/bin/env bash
# Isolated local Docker daemon only. No production endpoints, SSH or DNS operations.
set -euo pipefail
cd "$(dirname "$0")/.."
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
FAFA_SMOKE_ID="fafa-smoke-$RANDOM"
FAFA_DOCKER_TMP=$(mktemp -d /tmp/fafa-docker-XXXXXX)
cleanup() {
  docker rm -f "$FAFA_SMOKE_ID" > /dev/null 2>&1 || true
  rm -rf "$FAFA_DOCKER_TMP"
}
trap cleanup EXIT
# A synthetic disposable PostgreSQL password is supplied via an env file, never echoed.
.venv/bin/python - "$FAFA_DOCKER_TMP" <<'PY'
import pathlib,secrets,sys
p=pathlib.Path(sys.argv[1]);pw=secrets.token_hex(24)
(p/'postgres.env').write_text('POSTGRES_PASSWORD='+pw+'\nPOSTGRES_USER=fafa\nPOSTGRES_DB=fafa_test\n')
PY
docker run -d --name "$FAFA_SMOKE_ID" --env-file "$FAFA_DOCKER_TMP/postgres.env" -p 127.0.0.1::5432 postgres:17-alpine > /dev/null
FAFA_TEST_PORT=$(docker port "$FAFA_SMOKE_ID" 5432/tcp)
export FAFA_TEST_PORT
.venv/bin/python - "$FAFA_DOCKER_TMP" <<'PY'
import os,pathlib,sys
p=pathlib.Path(sys.argv[1]);pw=p.joinpath('postgres.env').read_text().splitlines()[0].split('=',1)[1]
(p/'test.url').write_text('postgresql+psycopg://fafa:'+pw+'@'+os.environ['FAFA_TEST_PORT']+'/fafa_test')
PY
for _ in $(seq 1 40); do
  if docker exec "$FAFA_SMOKE_ID" pg_isready -U fafa -d fafa_test > /dev/null; then break; fi
  sleep .5
done
FAFA_TEST_DATABASE_URL=$(cat "$FAFA_DOCKER_TMP/test.url")
export FAFA_TEST_DATABASE_URL
.venv/bin/python -m pytest backend/tests -q --disable-warnings

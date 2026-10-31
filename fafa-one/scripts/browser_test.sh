#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
FAFA_TEST_DIR=$(mktemp -d /tmp/fafa-browser-XXXXXX)
export DATABASE_URL="sqlite:///$FAFA_TEST_DIR/browser.db" APP_ENV=development COOKIE_SECURE=false PUBLIC_ORIGIN=http://127.0.0.1:5173 REQUIRE_VERIFIED_EMAIL=false
APP_SECRET=$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))')
export APP_SECRET
AI_KEY_ENCRYPTION_KEY=$(.venv/bin/python -c 'import secrets,base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())')
export AI_KEY_ENCRYPTION_KEY
cleanup() {
  kill "${FAFA_API_PID:-}" "${FAFA_WEB_PID:-}" 2>/dev/null || true
  rm -rf "$FAFA_TEST_DIR"
}
trap cleanup EXIT
(cd backend && ../.venv/bin/alembic upgrade head)
PYTHONPATH=backend .venv/bin/python scripts/browser_fixture.py
(cd backend && exec ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log) > /tmp/fafa-browser-api.log 2>&1 &
FAFA_API_PID=$!
(cd frontend && exec npm run preview -- --host 127.0.0.1 --port 5173) > /tmp/fafa-browser-web.log 2>&1 &
FAFA_WEB_PID=$!
.venv/bin/python - <<'PY'
import urllib.request,time
for url in ['http://127.0.0.1:8000/api/health','http://127.0.0.1:5173']:
 for _ in range(50):
  try:urllib.request.urlopen(url,timeout=1);break
  except OSError:time.sleep(.2)
 else:raise SystemExit('Test server startup failed')
PY
(cd frontend && npm run test:e2e)

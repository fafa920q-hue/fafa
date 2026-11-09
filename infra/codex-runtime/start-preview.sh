#!/usr/bin/env bash
# Run on the existing EC2 from the committed development worktree.
set -euo pipefail
umask 077
export PATH=/opt/fafa-one/tools/node-v24.22.2-linux-x64/bin:/opt/fafa-one/tools/pnpm/bin:$PATH
root=$(mktemp -d /opt/fafa-one/development/platform-native-preview.XXXXXXXX)
echo "$root"
sha=$(git rev-parse HEAD)
printf '%s\n' "$sha" > "$root/commit.sha"
mkdir "$root/release"
git archive "$sha" | tar -xf - -C "$root/release"
cd "$root/release"
pnpm install --offline --frozen-lockfile --ignore-scripts > "$root/install.log" 2>&1
pnpm typecheck > "$root/typecheck.log" 2>&1
pnpm build > "$root/build.log" 2>&1
VITE_ADMIN_ORIGIN=http://127.0.0.1:39221 pnpm exec vite build \
  --config apps/web/vite.config.ts --mode preview --outDir "$root/web" > "$root/preview-build.log" 2>&1
pnpm exec vite build --config apps/admin/vite.config.ts --mode preview --outDir "$root/admin" >> "$root/preview-build.log" 2>&1

ns="fafa-preview-$(openssl rand -hex 5)"
db="$ns-pg"
pw=$(openssl rand -hex 24)
image=$(sudo -n docker image inspect mcr.microsoft.com/playwright:v1.64.1-noble --format '{{.Id}}')
binary=$(readlink -f "$(command -v codex)")
sudo -n docker volume create "$db" >/dev/null
sudo -n docker run --pull=never -d --name "$db" --memory=512m -p 127.0.0.1::5432 \
  -v "$db:/var/lib/postgresql/data" -e POSTGRES_DB=fafa_preview -e POSTGRES_USER=fafa_preview \
  -e POSTGRES_PASSWORD="$pw" postgres:17.7-alpine > /dev/null
printf '%s\n' "$db" > "$root/db-container"
for n in $(seq 1 45); do
  sudo -n docker exec "$db" pg_isready -U fafa_preview -d fafa_preview >/dev/null 2>&1 && break
  sleep 1
done
port=$(sudo -n docker port "$db" 5432/tcp | cut -d: -f2)
cat > "$root/runtime.env" <<ENV
NODE_ENV=development
DEV_MOCK_LOGIN=true
DEMO_MODE=false
DOTENV_CONFIG_PATH=/dev/null
DATABASE_URL=postgres://fafa_preview:$pw@127.0.0.1:$port/fafa_preview
ENCRYPTION_KEY=$(openssl rand -base64 32)
WEB_ORIGIN=http://127.0.0.1:39220
ADMIN_ORIGIN=http://127.0.0.1:39221
API_PREVIEW_SOCKET=$root/api.sock
PLATFORM_CODEX_ENABLED=true
PLATFORM_CODEX_EXEC_ENABLED=true
CODEX_RUNNER_NAMESPACE=$ns
CODEX_RUNNER_SUDO=true
CODEX_RUNNER_BINARY=$binary
CODEX_RUNNER_IMAGE=$image
ENV
unset pw
set -a
source "$root/runtime.env"
set +a
pnpm exec tsx packages/db/src/migrate.ts > "$root/migrate.log" 2>&1
sudo -n docker exec -i "$db" psql -X -qAt -U fafa_preview -d fafa_preview -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users(id,email,name,role,codex_tasks_enabled) VALUES
 ('11111111-1111-4111-8111-111111111111','owner@preview.invalid','Preview Owner','Owner',true),
 ('22222222-2222-4222-8222-222222222222','member@preview.invalid','Preview Member','Member',true),
 ('33333333-3333-4333-8333-333333333333','viewer@preview.invalid','Preview Viewer','Viewer',false);
SQL
nohup node --import tsx apps/api/src/index.ts > "$root/api.log" 2>&1 < /dev/null &
echo $! > "$root/api.pid"
nohup node --import tsx apps/worker/src/index.ts > "$root/worker.log" 2>&1 < /dev/null &
echo $! > "$root/worker.pid"
nohup node --import tsx apps/codex-worker/src/index.ts > "$root/codex-worker.log" 2>&1 < /dev/null &
echo $! > "$root/codex-worker.pid"
nohup node infra/codex-runtime/preview-gateway.mjs "$root" > "$root/gateway.log" 2>&1 < /dev/null &
echo $! > "$root/gateway.pid"
for n in $(seq 1 35); do
  if test -S "$root/web.sock" && test -S "$root/admin.sock" &&
    curl -fs --max-time 2 --unix-socket "$root/api.sock" http://localhost/api/ready >/dev/null; then
    echo PREVIEW_SERVING
    exit 0
  fi
  sleep 1
done
echo PREVIEW_STARTUP_INCOMPLETE
exit 1


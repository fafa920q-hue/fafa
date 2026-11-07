#!/usr/bin/env bash
set -euo pipefail
umask 077
deployment_sha="${1:?pass approved full commit SHA}"
deployment_action="${2:-deploy}"
[[ "$deployment_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$deployment_action" == deploy || "$deployment_action" == check ]]
cd /opt/fafa-one
source infra/scripts/repository-git.sh
exec 9>/opt/fafa-one/.deployment.lock
flock -n 9
[[ -f .env.production && ! -L .env.production ]]
if [[ "$deployment_action" == deploy ]]; then chmod 600 .env.production; fi
[[ "$(stat -c %a .env.production)" == 600 ]]
[[ "$(repository_git rev-parse HEAD)" == "$deployment_sha" ]]
[[ -z "$(repository_git status --porcelain --untracked-files=no)" ]]
if [[ "$(repository_git rev-parse --is-shallow-repository)" == true ]]; then repository_git fetch --unshallow origin; fi
if [[ -e .deployed-sha ]]; then
  [[ -f .deployed-sha && ! -L .deployed-sha ]]
  [[ "$(cat .deployed-sha)" =~ ^[0-9a-f]{40}$ ]]
fi
export IMAGE_TAG="$deployment_sha"
compose=(docker compose --env-file .env.production -f infra/docker/compose.production.yaml)
if [[ "$deployment_action" == check ]]; then
  repository_git rev-parse HEAD
  "${compose[@]}" ps --all --format json
  exit 0
fi
# Only source changes require rebuilding; no installation, disk, swap or key regeneration.
for target in runtime web admin; do
  repository_git archive "$deployment_sha" | docker build -f infra/docker/Dockerfile --target "$target" -t "fafa-one-$target:$deployment_sha" -
done
env_owner="$(stat -c %u .env.production):$(stat -c %g .env.production)"
runtime_owner="$(stat -c %u .):$(stat -c %g .)"
if [[ -f .env.runtime ]]; then runtime_owner="$(stat -c %u .env.runtime):$(stat -c %g .env.runtime)"; fi
repository_git log -p --all -- . ':!pnpm-lock.yaml' | "${compose[@]}" run --rm -T --no-deps --user "$env_owner" -v /opt/fafa-one:/config:ro ops node --import tsx infra/scripts/audit-production-config.ts
"${compose[@]}" config --quiet
mkdir -p backups deployments
chmod 700 backups deployments
# Record only public status and image identifiers; never serialize container Env.
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' > "deployments/$deployment_sha-before.txt"
"${compose[@]}" up -d --wait --wait-timeout 120 postgres
backup_path="$(mktemp "backups/pre-$deployment_sha-XXXXXX.dump.envelope")"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' |
  "${compose[@]}" run --rm -T --no-deps ops node --max-old-space-size=2048 --import tsx infra/scripts/backup-envelope.ts encrypt > "$backup_path"
[[ -s "$backup_path" ]]
chmod 600 "$backup_path"
# Before using the backup, verify authenticated decryption and pg_restore's catalog.
"${compose[@]}" run --rm -T --no-deps ops node --max-old-space-size=2048 --import tsx infra/scripts/backup-envelope.ts decrypt < "$backup_path" |
  "${compose[@]}" exec -T postgres pg_restore --list > /dev/null
# Preserve the existing admin DB password and encryption key. Create a separate app identity only if absent.
"${compose[@]}" run --rm -T --no-deps --user "$runtime_owner" -v /opt/fafa-one:/config ops node --import tsx infra/scripts/prepare-production-db.ts --identity-only
"${compose[@]}" stop api worker
deployment_failed() {
  "${compose[@]}" stop api worker >/dev/null 2>&1 || true
  printf '%s\n' 'Deployment failed. Database, keys, backups and old images preserved; API/Worker remain stopped for safe recovery.' >&2
}
trap deployment_failed ERR
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" run --rm -T --no-deps --user "$runtime_owner" -v /opt/fafa-one:/config ops node --import tsx infra/scripts/prepare-production-db.ts
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api worker web admin
"${compose[@]}" up -d --no-deps --force-recreate proxy
"${compose[@]}" exec -T api node --import tsx -e 'import("./infra/scripts/check-runtime-db.ts").then(m=>m.assertRuntimeDatabaseRole()).then(()=>import("./packages/db/src/index.ts")).then(m=>m.sql.end()).then(()=>console.log("runtime-role-ok"))'
"${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/ready").then(r=>{if(!r.ok)process.exit(1)})'
if [[ -n "$("${compose[@]}" port api 4000 2>/dev/null || true)" || -n "$("${compose[@]}" port postgres 5432 2>/dev/null || true)" ]]; then
  printf '%s\n' 'Forbidden published database/API port' >&2
  deployment_failed
  exit 1
fi
"${compose[@]}" ps --all --format json > "deployments/$deployment_sha-services.json"
"${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select name from migrations order by name"' > "deployments/$deployment_sha-migrations.txt"
"${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At' < infra/deploy/status.sql > "deployments/$deployment_sha-owner.json"
# Do not overwrite an existing operator-defined backup unit.
for unit in fafa-backup.service fafa-backup.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]] && ! cmp -s "infra/deploy/$unit" "/etc/systemd/system/$unit"; then
    printf '%s\n' 'Existing backup policy differs; preserving it, manual verification required.' >&2
    deployment_failed
    exit 1
  fi
done
printf '%s\n' "$deployment_sha" > .deployed-sha
chmod 600 .deployed-sha
for unit in fafa-backup.service fafa-backup.timer; do
  if [[ ! -e "/etc/systemd/system/$unit" ]]; then install -m 644 "infra/deploy/$unit" "/etc/systemd/system/$unit"; fi
done
systemctl daemon-reload
systemctl enable docker >/dev/null
systemctl enable --now fafa-backup.timer >/dev/null
trap - ERR
printf '%s\n' 'FAFA_DEPLOY_RESULT={"deployed":true,"databaseBackupVerified":true,"runtimeRole":"fafa_app","ports4000and5432Published":false,"ownerGoogleLogin":"REQUIRES_BROWSER_VERIFICATION","nodeImport":"NOT_PERFORMED"}'

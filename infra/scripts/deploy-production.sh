#!/usr/bin/env bash
set -euo pipefail
umask 077
deployment_sha="${1:?pass approved full commit SHA}"
deployment_action="${2:-deploy}"
[[ "$deployment_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$deployment_action" == deploy || "$deployment_action" == check ]]
cd "${FAFA_ROOT:-/opt/fafa-one}"
source infra/scripts/repository-git.sh
exec 9>"${FAFA_ROOT:-/opt/fafa-one}/.deployment.lock"
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
# --- Recovery model (stage H fix, 2026-11-13) ----------------------------------
# Failure classes and the service state after each phase:
#   * Before "compose stop api worker": services still serve the previous
#     version. Any failure (build, config audit, backup, pre-deploy check)
#     leaves the old version running; the handler only reports it.
#   * After the stop and before verification passes: the new version is not
#     yet proven. A failure must trigger an automatic rollback to the
#     previous version (rollback_needed=1) and verify it.
#   * After verification passes (services_healthy=1): the new version is
#     proven. A failure in bookkeeping (recording deployments files,
#     .deployed-sha, backup-unit install) must NOT stop or roll back the
#     healthy services; it is reported and exits non-zero.
# Image pinning: every image is identified by its digest (docker image Id,
# sha256:...). The deploy verifies the running containers match the new
# digests, and the rollback uses the previous digests captured at the start
# of THIS run (never a stored inspect JSON).
# Isolation-harness override: FAFA_ROOT (default /opt/fafa-one). The SSM
# deploy sets none of these, so production behaviour is unchanged.
FAFA_ROOT="${FAFA_ROOT:-/opt/fafa-one}"
previous_sha="$(cat .deployed-sha)"
[[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'previous .deployed-sha is not a full commit SHA\n' >&2; exit 1; }
rollback_needed=0
services_healthy=0
recovering=0
new_images_file="deployments/$deployment_sha-images.json"
previous_images_file="deployments/$deployment_sha-previous-images.json"
deploy_min_free_kib=6291456

# usage: image_digest <image-ref>  -> prints sha256:... or fails
image_digest() {
  docker image inspect --format '{{.Id}}' "$1"
}

# usage: record_image_digest <target> <image-ref> <file>
# Appends "target digest" to a digest record (no env, no secrets).
record_image_digest() {
  local target="$1" ref="$2" file="$3" digest
  digest="$(image_digest "$ref")" || return 1
  printf '%s %s\n' "$target" "$digest" >> "$file"
}

# usage: verify_running_image <service> <expected-digest>
verify_running_image() {
  local service="$1" expected="$2" cid actual
  cid="$("${compose[@]}" ps -q "$service")" || return 1
  [[ -n "$cid" ]] || return 1
  actual="$(docker inspect --format '{{.Image}}' "$cid")" || return 1
  [[ "$actual" == "$expected" ]]
}

# usage: verify_new_images
# The running api/worker/web/admin containers must be the newly built
# images (by digest), not a stale or wrong image.
verify_new_images() {
  local target digest
  while read -r target digest; do
    case "$target" in
      runtime) verify_running_image api "$digest" || return 1; verify_running_image worker "$digest" || return 1 ;;
      web) verify_running_image web "$digest" || return 1 ;;
      admin) verify_running_image admin "$digest" || return 1 ;;
    esac
  done < "$new_images_file"
}

# usage: verify_service_health
# The same health probes the deploy uses, run again after a rollback.
verify_service_health() {
  "${compose[@]}" exec -T api node --import tsx -e 'import("./infra/scripts/check-runtime-db.ts").then(m=>m.assertRuntimeDatabaseRole()).then(()=>import("./packages/db/src/index.ts")).then(m=>m.sql.end()).then(()=>console.log("runtime-role-ok"))' || return 1
  "${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/ready").then(r=>{if(!r.ok)process.exit(1)})' || return 1
  python3 infra/deploy/check_container_ports.py "${compose[@]}" || return 1

}

# usage: rollback_to_previous
# Restores api/worker/web/admin/proxy on the previous version and verifies
# them. The previous digests were captured at the start of THIS run.
rollback_to_previous() {
  trap - ERR
  printf 'ROLLBACK: restoring previous version %s\n' "$previous_sha" >&2
  export IMAGE_TAG="$previous_sha"
  "${compose[@]}" stop api worker web admin proxy >/dev/null 2>&1 || true
  if ! "${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api worker web admin; then
    printf 'ROLLBACK_FAIL: previous api/worker/web/admin did not come up\n' >&2
    return 1
  fi
  if ! "${compose[@]}" up -d --no-deps --force-recreate proxy; then
    printf 'ROLLBACK_FAIL: previous proxy did not come up\n' >&2
    return 1
  fi
  if ! verify_service_health; then
    printf 'ROLLBACK_FAIL: previous version failed health verification\n' >&2
    return 1
  fi
  local target digest ok=1
  while read -r target digest; do
    case "$target" in
      runtime) verify_running_image api "$digest" || ok=0; verify_running_image worker "$digest" || ok=0 ;;
      web) verify_running_image web "$digest" || ok=0 ;;
      admin) verify_running_image admin "$digest" || ok=0 ;;
    esac
  done < "$previous_images_file"
  [[ "$ok" == 1 ]] || { printf 'ROLLBACK_FAIL: rolled-back image digest mismatch\n' >&2; return 1; }
  printf 'ROLLBACK_OK: services restored on %s\n' "$previous_sha" >&2
  return 0
}

deployment_failed() {
  local status=$?
  trap - ERR
  if [[ "$rollback_needed" == 1 && "$services_healthy" == 0 && "$recovering" == 0 ]]; then
    recovering=1
    if rollback_to_previous; then
      printf 'Deployment failed (exit %s). Services were rolled back to %s and verified healthy. Redeploy only after fixing the new image.\n' "$status" "$previous_sha" >&2
      printf 'FAFA_DEPLOY_RESULT={"deployed":false,"rolledBack":true,"previousSha":"%s"}\n' "$previous_sha" >&2
      exit 1
    fi
    printf 'ROLLBACK_FAILED: automatic rollback to %s failed. API/Worker may be down; manual recovery is required.\n' "$previous_sha" >&2
    printf 'MANUAL_RECOVERY: export IMAGE_TAG=%s; docker compose --env-file .env.production -f infra/docker/compose.production.yaml up -d --wait --wait-timeout 180 api worker web admin; then up -d --force-recreate proxy; then verify /ready and container ports.\n' "$previous_sha" >&2
    exit 1
  fi
  if [[ "$services_healthy" == 1 ]]; then
    printf 'Deployment failed (exit %s) AFTER the new version passed health verification. Services are left RUNNING on %s; only bookkeeping failed. Do not roll back automatically.\n' "$status" "$deployment_sha" >&2
    exit 1
  fi
  printf 'Deployment failed (exit %s) before services were stopped. Current version %s is still serving.\n' "$status" "$previous_sha" >&2
  exit 1
}

# From here on, any failing command reports through deployment_failed.
trap deployment_failed ERR
if [[ "$deployment_action" == check ]]; then
  repository_git rev-parse HEAD
  "${compose[@]}" ps --all --format json
  exit 0
fi
# The new mail credential must come from the audited AWS-to-tmpfs staging step.
# Do not interpolate it into Compose environment metadata or production env files.
[[ "${FAFA_RESEND_SECRET_FILE:-}" == /run/fafa-one/secrets/resend_api_key ]]
[[ -f "$FAFA_RESEND_SECRET_FILE" && ! -L "$FAFA_RESEND_SECRET_FILE" ]]
[[ "$(stat -c %a "$FAFA_RESEND_SECRET_FILE")" == 400 ]]
[[ "$(stat -c %u "$FAFA_RESEND_SECRET_FILE")" == 1000 ]]
[[ "$(findmnt -n -o FSTYPE -T "$FAFA_RESEND_SECRET_FILE")" == tmpfs ]]
compose+=(-f infra/docker/compose.mail-secret.yaml)
# Only source changes require rebuilding; no installation, disk, swap or key regeneration.
for target in runtime web admin; do
  repository_git archive "$deployment_sha" | docker build -f infra/docker/Dockerfile --target "$target" -t "fafa-one-$target:$deployment_sha" -
done
env_owner="$(stat -c %u .env.production):$(stat -c %g .env.production)"
runtime_owner="$(stat -c %u .):$(stat -c %g .)"
if [[ -f .env.runtime ]]; then runtime_owner="$(stat -c %u .env.runtime):$(stat -c %g .env.runtime)"; fi
repository_git log -p --all -- . ':!pnpm-lock.yaml' | "${compose[@]}" run --rm -T --no-deps --user "$env_owner" -v ${FAFA_ROOT:-/opt/fafa-one}:/config:ro ops node --import tsx infra/scripts/audit-production-config.ts
"${compose[@]}" config --quiet
mkdir -p backups deployments

# --- Pre-deploy dependency checks (stage H fix) -----------------------------
# All of these run BEFORE any service is stopped, so a failure here leaves
# the previous version serving.
# Record the digests of the newly built images (fixed-image pinning).
: > "$new_images_file"
for target in runtime web admin; do
  record_image_digest "$target" "fafa-one-$target:$deployment_sha" "$new_images_file" || {
    printf 'PRE_DEPLOY_FAIL: newly built image fafa-one-%s:%s is missing\n' "$target" "$deployment_sha" >&2
    exit 1
  }
done
# The rollback target images must already exist locally; otherwise a failed
# deploy could not be rolled back.
: > "$previous_images_file"
for target in runtime web admin; do
  record_image_digest "$target" "fafa-one-$target:$previous_sha" "$previous_images_file" || {
    printf 'PRE_DEPLOY_FAIL: previous image fafa-one-%s:%s is missing; rollback would be impossible\n' "$target" "$previous_sha" >&2
    exit 1
  }
done
# Disk gate: the build is the peak. Require the 6 GiB production safety
# margin to still hold after the build; otherwise fail before stopping
# services. Threshold is tunable via deploy_min_free_kib.
free_kib="$(df -k --output=avail / | tail -n 1 | tr -d ' ')"
if [[ "$free_kib" -lt "$deploy_min_free_kib" ]]; then
  printf 'PRE_DEPLOY_FAIL: only %s KiB free after the build; need at least %s KiB (6 GiB safety margin)\n' "$free_kib" "$deploy_min_free_kib" >&2
  exit 1
fi
# Backup policy check (moved here from after the deploy): if the operator
# has defined backup units that differ from the repository version, fail
# fast while the old version is still serving.
for unit in fafa-backup.service fafa-backup.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]] && ! cmp -s "infra/deploy/$unit" "/etc/systemd/system/$unit"; then
    printf '%s\n' 'Existing backup policy differs; preserving it, manual verification required.' >&2
    exit 1
  fi
done
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
"${compose[@]}" run --rm -T --no-deps --user "$runtime_owner" -v ${FAFA_ROOT:-/opt/fafa-one}:/config ops node --import tsx infra/scripts/prepare-production-db.ts --identity-only
"${compose[@]}" stop api worker

# From here, a failure must roll back to the previous version.
rollback_needed=1
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" run --rm -T --no-deps --user "$runtime_owner" -v ${FAFA_ROOT:-/opt/fafa-one}:/config ops node --import tsx infra/scripts/prepare-production-db.ts
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api worker web admin
"${compose[@]}" up -d --no-deps --force-recreate proxy
"${compose[@]}" exec -T api node --import tsx -e 'import("./infra/scripts/check-runtime-db.ts").then(m=>m.assertRuntimeDatabaseRole()).then(()=>import("./packages/db/src/index.ts")).then(m=>m.sql.end()).then(()=>console.log("runtime-role-ok"))'
"${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/ready").then(r=>{if(!r.ok)process.exit(1)})'
# Inspect actual container metadata; compose port may return misleading ':0'.
# Nonzero status triggers the existing ERR trap and preserves safe recovery.
python3 infra/deploy/check_container_ports.py "${compose[@]}"

# The new version is proven healthy from here; later failures are
# bookkeeping only and must not stop or roll back the services.
verify_new_images
services_healthy=1
"${compose[@]}" ps --all --format json > "deployments/$deployment_sha-services.json"
"${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -Atc "select name from migrations order by name"' > "deployments/$deployment_sha-migrations.txt"
"${compose[@]}" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At' < infra/deploy/status.sql > "deployments/$deployment_sha-owner.json"
# The backup-unit policy check already ran before services were stopped
# (see the pre-deploy checks); a mismatch would have failed fast while
# the old version was still serving. Nothing to re-check here.
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

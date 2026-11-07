#!/usr/bin/env bash
# Disposable GitHub-hosted CI only. Never execute this fixture on AWS.
set -euo pipefail
umask 077
[[ "${GITHUB_ACTIONS:-}" == true ]]
[[ "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$PWD" == "$GITHUB_WORKSPACE" && "$PWD" == /home/runner/work/* ]]
[[ ! -e .env.production && ! -e .env.runtime && ! -e .deployed-sha ]]
project="fafa-startup-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
if docker volume inspect "${project}_pg" >/dev/null 2>&1; then
  printf '%s\n' 'Existing volume detected; refusing to reuse or remove it.' >&2
  exit 1
fi
export IMAGE_TAG="$(git rev-parse HEAD)"
compose=(docker compose -p "$project" --env-file .env.production -f infra/docker/compose.production.yaml)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const password = randomBytes(32).toString('base64url');
const fields = {
  NODE_ENV: 'production', DEMO_MODE: 'false', DEV_MOCK_LOGIN: 'false',
  PANEL_DOMAIN: 'fafa888.uk', ADMIN_DOMAIN: 'a.fafa888.uk',
  WEB_ORIGIN: 'https://fafa888.uk', ADMIN_ORIGIN: 'https://a.fafa888.uk',
  API_PUBLIC_URL: 'https://fafa888.uk',
  GOOGLE_REDIRECT_URI: 'https://fafa888.uk/auth/google/callback',
  GOOGLE_CLIENT_ID: 'ci-startup.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: randomBytes(24).toString('base64url'),
  COOKIE_DOMAIN: '', POSTGRES_PASSWORD: password,
  MAIL_PROVIDER: 'resend', MAIL_API_KEY: randomBytes(24).toString('base64url'),
  MAIL_FROM: 'ci-mail@example.invalid',
  DATABASE_URL: 'postgres://fafa:' + password + '@postgres:5432/fafa',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), IMAGE_TAG: process.env.IMAGE_TAG,
};
writeFileSync('.env.production', Object.entries(fields).map(([k,v]) =>
  k + '=' + JSON.stringify(v)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
JS
for target in runtime web admin; do
  git archive "$IMAGE_TAG" | docker build -f infra/docker/Dockerfile --target "$target" -t "fafa-one-$target:$IMAGE_TAG" -
done
"${compose[@]}" config --quiet
"${compose[@]}" --profile tools config --format json | node --input-type=module -e '
let input=""; for await (const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input);
for(const name of ["api","worker","postgres"]) {
  if(config.services[name].ports?.length) throw Error("Internal service published");
}
for(const name of ["api","worker"]) {
  const env=config.services[name].environment;
  if(env.POSTGRES_PASSWORD || env.DATABASE_URL) throw Error("Unexpected privileged runtime credential");
}
const apiEnv=config.services.api.environment;
if(apiEnv.MAIL_PROVIDER!=="resend" || !apiEnv.MAIL_API_KEY || apiEnv.MAIL_FROM!=="ci-mail@example.invalid")
  throw Error("API mail environment was not forwarded");
for(const key of ["MAIL_PROVIDER","MAIL_API_KEY","MAIL_FROM"])
  if(config.services.worker.environment[key]!==undefined) throw Error("Mail environment leaked into worker");
if(config.services.ops.logging.driver!=="none") throw Error("Ops logging enabled");
console.log("First-deployment compose contract passed with no runtime file.");'
owner="$(id -u):$(id -g)"
ops=("${compose[@]}" run --rm -T --no-deps)
git log -p --all -- . ':!pnpm-lock.yaml' | "${ops[@]}" --user "$owner" -v "$PWD:/config:ro" ops node --import tsx infra/scripts/audit-production-config.ts
for invalid in COOKIE_DOMAIN=.invalid.example PANEL_DOMAIN=invalid.example DATABASE_URL=postgres://fafa:wrong@postgres:5432/fafa; do
  if "${ops[@]}" --user "$owner" -v "$PWD:/config:ro" -e "$invalid" ops node --import tsx infra/scripts/audit-production-config.ts < /dev/null; then
    printf '%s\n' 'Invalid production configuration was accepted.' >&2
    exit 1
  fi
done
"${compose[@]}" up -d --wait --wait-timeout 120 postgres
before="$RUNNER_TEMP/fafa-before-migration.envelope"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' |
  "${ops[@]}" ops node --import tsx infra/scripts/backup-envelope.ts encrypt > "$before"
"${ops[@]}" ops node --import tsx infra/scripts/backup-envelope.ts decrypt < "$before" |
  "${compose[@]}" exec -T postgres pg_restore --list > /dev/null
"${ops[@]}" --user "$owner" -v "$PWD:/config" ops node --import tsx infra/scripts/prepare-production-db.ts --identity-only
[[ "$(stat -c %a .env.runtime)" == 600 ]]
"${compose[@]}" run --rm -T --no-deps migrate
"${ops[@]}" --user "$owner" -v "$PWD:/config" ops node --import tsx infra/scripts/prepare-production-db.ts
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api worker web admin
python3 infra/deploy/check_container_ports.py "${compose[@]}"
"${compose[@]}" stop api
if python3 infra/deploy/check_container_ports.py "${compose[@]}" > "$RUNNER_TEMP/fafa-port-check.stdout" 2> "$RUNNER_TEMP/fafa-port-check.stderr"; then
  printf '%s\n' 'Stopped API was incorrectly accepted.' >&2
  exit 1
fi
python3 - "$RUNNER_TEMP/fafa-port-check.stderr" <<'PY'
import pathlib
import sys
diagnostic = pathlib.Path(sys.argv[1]).read_text()
assert "SERVICE_NOT_RUNNING: api" in diagnostic
assert "Forbidden published" not in diagnostic
PY
"${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api
python3 infra/deploy/check_container_ports.py "${compose[@]}"
"${compose[@]}" exec -T api node --input-type=module <<'JS'
import assert from 'node:assert/strict';
assert.equal(new URL(process.env.DATABASE_URL).username, 'fafa_app');
assert.equal(process.env.POSTGRES_PASSWORD, undefined);
assert.equal((await fetch('http://127.0.0.1:4000/api/ready')).status, 200);
assert.equal((await fetch('http://127.0.0.1:4000/api/me')).status, 401);
const config = await (await fetch('http://127.0.0.1:4000/auth/config')).json();
assert.equal(config.mock, false); assert.equal(config.demo, false);
assert.equal(config.google, true); assert.equal(config.ownerSetup, false);
const member = await (await fetch('http://127.0.0.1:4000/auth/member/config')).json();
assert.equal(member.registrationOpen, false);
assert.equal(member.mailConfigured, true);
const { sql } = await import('./packages/db/src/index.ts');
for (const table of ['member_credentials','member_registrations','member_action_tokens','member_auth_buckets','member_google_links']) {
  for (const privilege of ['SELECT','INSERT','UPDATE']) {
    const [grant] = await sql.unsafe('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table,privilege]);
    assert.equal(grant.allowed, true);
  }
  for (const privilege of ['DELETE','TRUNCATE']) {
    const [grant] = await sql.unsafe('SELECT has_table_privilege(current_user,$1,$2) AS allowed', [table,privilege]);
    assert.equal(grant.allowed, false);
  }
}
await sql.end();
assert.equal((await fetch('http://127.0.0.1:4000/auth/dev', {
  method: 'POST', headers: { origin: 'https://fafa888.uk', 'content-type':'application/json' },
  body: JSON.stringify({ profile: 'owner' })
})).status, 404);
for (const service of ['web', 'admin'])
  assert.equal((await fetch('http://' + service + ':8080')).status, 200);
console.log('Production runtime identity, login isolation and independent static services passed.');
JS
"${compose[@]}" exec -T worker node --input-type=module -e '
import assert from "node:assert/strict";
assert.equal(new URL(process.env.DATABASE_URL).username,"fafa_app");
assert.equal(process.env.POSTGRES_PASSWORD,undefined);'
"${compose[@]}" exec -T postgres psql -U fafa -d fafa -X -v ON_ERROR_STOP=1 -c "INSERT INTO users(email,name,role) VALUES('startup-fixture@example.invalid','Disposable CI restore fixture','Member')" > /dev/null
after="$RUNNER_TEMP/fafa-after-migration.envelope"
"${compose[@]}" exec -T postgres pg_dump -U fafa -d fafa -Fc --no-owner |
  "${ops[@]}" ops node --import tsx infra/scripts/backup-envelope.ts encrypt > "$after"
"${compose[@]}" exec -T postgres createdb -U fafa fafa_restore_ci
"${ops[@]}" ops node --import tsx infra/scripts/backup-envelope.ts decrypt < "$after" |
  "${compose[@]}" exec -T postgres pg_restore -U fafa -d fafa_restore_ci --single-transaction --exit-on-error --no-owner --no-privileges
restored="$("${compose[@]}" exec -T postgres psql -U fafa -d fafa_restore_ci -X -Atc "SELECT count(*) FROM users WHERE email='startup-fixture@example.invalid'")"
[[ "$restored" == 1 ]]
"${compose[@]}" restart postgres
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 postgres
persisted="$("${compose[@]}" exec -T postgres psql -U fafa -d fafa -X -Atc "SELECT count(*) FROM users WHERE email='startup-fixture@example.invalid'")"
[[ "$persisted" == 1 ]]
migration_count="$("${compose[@]}" exec -T postgres psql -U fafa -d fafa -X -Atc "SELECT count(*) FROM migrations WHERE name IN ('001_initial.sql','002_limits.sql','003_owner_setup.sql','004_traffic_policy.sql','005_member_auth.sql')")"
[[ "$migration_count" == 5 ]]
mkdir -p docs/evidence
"${compose[@]}" ps --all --format json > docs/evidence/production-startup-containers.json
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
writeFileSync('docs/evidence/production-startup.json', JSON.stringify({
  verifiedAt: new Date().toISOString(), commit: process.env.IMAGE_TAG,
  scope: 'Disposable GitHub-hosted Compose stack, no AWS access, proxy not started',
  missingRuntimeFileAccepted: true, runtimeFileMode600: true,
  actualPortBindingsChecked: true, stoppedApiDistinguishedFromPortPublishing: true,
  privilegedDatabasePasswordExcluded: true, runtimeRole: 'fafa_app',
  encryptedPreMigrationBackupVerified: true, migrationsApplied: ['001','002','003','004','005'],
  memberRuntimeGrantsVerified: true, mailEnvironmentApiOnlyVerified: true,
  mailConfiguredWhileRegistrationRemainsClosed: true, realMailDelivery: 'NOT_TESTED',
  restoreToSeparateDatabase: true, postgresRestartPersistence: true,
  demoLoginDisabled: true, apiReady: true, independentWebAndAdmin: true,
  publicHttps: 'NOT_TESTED', googleLogin: 'NOT_TESTED', ownerBinding: 'NOT_PERFORMED'
}, null, 2) + '\n');
JS
printf '%s\n' 'Isolated production startup, encrypted restore and persistence passed.'

#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?set a NEW empty database URL}"
: "${AGE_IDENTITY_FILE:?set local identity file path}"
: "${1:?pass an encrypted backup path}"
if [[ "${CONFIRM_RESTORE:-}" != 'RESTORE_TO_NEW_DATABASE' ]]; then
  echo '恢复需要显式设置 CONFIRM_RESTORE=RESTORE_TO_NEW_DATABASE。只能恢复到新空库。' >&2
  exit 1
fi
command -v age >/dev/null
command -v pg_restore >/dev/null
command -v psql >/dev/null
existing_tables="$(node "$(dirname "$0")/pg-command.mjs" RESTORE_DATABASE_URL psql -X -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')")"
if [[ "$existing_tables" != '0' ]]; then
  echo '目标数据库不是空库，已拒绝恢复。' >&2
  exit 1
fi
# Single transaction prevents partially restored state on schema/data errors.
age -d -i "$AGE_IDENTITY_FILE" "$1" | node "$(dirname "$0")/pg-command.mjs" RESTORE_DATABASE_URL pg_restore --no-owner --exit-on-error --single-transaction

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
age -d -i "$AGE_IDENTITY_FILE" "$1" | pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error

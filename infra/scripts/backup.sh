#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in a secure shell}"
: "${AGE_RECIPIENT:?set age public recipient}"
command -v age >/dev/null
command -v pg_dump >/dev/null
umask 077
backup_directory="${BACKUP_DIRECTORY:-backups}"
mkdir -p "$backup_directory"
backup_path="$(mktemp "$backup_directory/fafa-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump.age")"
# The wrapper injects libpq variables without exposing a connection URL in process arguments.
node "$(dirname "$0")/pg-command.mjs" DATABASE_URL pg_dump --format=custom --no-owner | age -r "$AGE_RECIPIENT" -o "$backup_path"
printf '加密备份完成：%s\n' "$backup_path"

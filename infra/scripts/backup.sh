#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL in a secure shell}"
: "${AGE_RECIPIENT:?set age public recipient}"
command -v age >/dev/null
command -v pg_dump >/dev/null
umask 077
mkdir -p backups
backup_path="backups/fafa-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner | age -r "$AGE_RECIPIENT" -o "$backup_path"
printf '加密备份完成：%s\n' "$backup_path"

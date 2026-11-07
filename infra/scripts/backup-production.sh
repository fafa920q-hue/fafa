#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/fafa-one
exec 8>.backup.lock
flock -n 8
compose=(bash infra/scripts/production-compose.sh)
mkdir -p backups
backup_path="$(mktemp "backups/fafa-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump.envelope")"
"${compose[@]}" exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > /dev/null
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' |
  "${compose[@]}" run --rm -T --no-deps ops node --max-old-space-size=2048 --import tsx infra/scripts/backup-envelope.ts encrypt > "$backup_path"
"${compose[@]}" run --rm -T --no-deps ops node --max-old-space-size=2048 --import tsx infra/scripts/backup-envelope.ts decrypt < "$backup_path" |
  "${compose[@]}" exec -T postgres pg_restore --list > /dev/null
printf '%s\n' 'Encrypted database backup and authenticated catalog verification completed.'

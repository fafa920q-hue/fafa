#!/usr/bin/env bash
set -euo pipefail
[[ "$EUID" == 0 ]]
release="$(readlink -f /opt/fafa-one/current)"
[[ "$release" == /opt/fafa-one/releases/* && -f "$release/.release-sha" ]]
export IMAGE_TAG="$(cat "$release/.release-sha")"
[[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]
export FAFA_RESEND_SECRET_FILE=/run/fafa-one/secrets/resend_api_key
compose=(docker compose -p fafa-one --env-file /opt/fafa-one/.env.production -f "$release/infra/docker/compose.production.yaml" -f "$release/infra/docker/compose.mail-secret.yaml" -f "$release/infra/docker/compose.ec2.yaml")
case "${1:-}" in
  stage)
    if [[ ! -e "$FAFA_RESEND_SECRET_FILE" && ! -L "$FAFA_RESEND_SECRET_FILE" ]]; then
      python3 "$release/infra/deploy/stage_resend_secret.py" --store secretsmanager --reference prod/fafa-one/resend --region us-east-2
    fi
    [[ -f "$FAFA_RESEND_SECRET_FILE" && ! -L "$FAFA_RESEND_SECRET_FILE" ]]
    [[ "$(stat -c %a "$FAFA_RESEND_SECRET_FILE")" == 400 && "$(stat -c %u "$FAFA_RESEND_SECRET_FILE")" == 1000 ]]
    [[ "$(findmnt -n -o FSTYPE -T "$FAFA_RESEND_SECRET_FILE")" == tmpfs ]]
    ;;
  up)
    "${compose[@]}" config --quiet
    "${compose[@]}" up -d --no-deps --wait --wait-timeout 180 api worker web admin proxy
    ;;
  stop) "${compose[@]}" stop api worker ;;
  status) "${compose[@]}" ps --all --format json ;;
  *) printf '%s\n' 'usage: run-current-release.sh stage|up|stop|status' >&2; exit 2 ;;
esac

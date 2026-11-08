#!/usr/bin/env bash
set -euo pipefail
cd /opt/fafa-one
deployment_tag="$(cat .deployed-sha)"
[[ "$deployment_tag" =~ ^[0-9a-f]{40}$ ]]
docker image inspect "fafa-one-runtime:$deployment_tag" >/dev/null
export IMAGE_TAG="$deployment_tag"
compose=(docker compose --env-file .env.production -f infra/docker/compose.production.yaml)
if [[ -f /run/fafa-one/secrets/resend_api_key && ! -L /run/fafa-one/secrets/resend_api_key ]]; then
  export FAFA_RESEND_SECRET_FILE=/run/fafa-one/secrets/resend_api_key
  compose+=(-f infra/docker/compose.mail-secret.yaml)
fi
exec "${compose[@]}" "$@"

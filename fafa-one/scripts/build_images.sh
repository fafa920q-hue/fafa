#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
if [ -z "${BUILDX_CONFIG:-}" ]; then
  FAFA_BUILDX_TEMP=$(mktemp -d /tmp/fafa-buildx-XXXXXX)
  export BUILDX_CONFIG="$FAFA_BUILDX_TEMP"
  trap 'rm -rf "$FAFA_BUILDX_TEMP"' EXIT
fi
# Optional CA mount for managed cloud builds. No session CA is copied into an image.
FAFA_CA_BUNDLE=${CODEX_PROXY_CERT:-/etc/ssl/certs/ca-certificates.crt}
docker build --secret "id=proxy_ca,src=$FAFA_CA_BUNDLE" -t fafa-one-api:2.0.0-alpha.1 backend
docker build --secret "id=proxy_ca,src=$FAFA_CA_BUNDLE" -t fafa-one-web:2.0.0-alpha.1 frontend

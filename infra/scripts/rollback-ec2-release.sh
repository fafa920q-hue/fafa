#!/usr/bin/env bash
set -euo pipefail
[[ "$EUID" == 0 ]]
release="$(readlink -f /opt/fafa-one/current)"
[[ "$release" == /opt/fafa-one/releases/* ]]
previous="$(cat "$release/.previous-release")"
[[ "$previous" == /opt/fafa-one/releases/* && -f "$previous/.release-sha" ]]
export IMAGE_TAG="$(cat "$previous/.release-sha")"
[[ "$IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]
for target in runtime web admin; do docker image inspect "fafa-one-$target:$IMAGE_TAG" >/dev/null; done
systemctl disable --now fafa-one.service
docker compose -p fafa-one --env-file /opt/fafa-one/.env.production -f /opt/fafa-one/infra/docker/compose.production.yaml up -d --no-deps --wait --wait-timeout 180 api worker web admin proxy
temporary="/opt/fafa-one/current-rollback-$$"
[[ ! -e "$temporary" && ! -L "$temporary" ]]
ln -s "$previous" "$temporary"
mv -T "$temporary" /opt/fafa-one/current
printf '%s\n' "$IMAGE_TAG" > /opt/fafa-one/.deployed-sha
chmod 600 /opt/fafa-one/.deployed-sha
printf '%s\n' 'Application images rolled back; database and new authentication records preserved.'

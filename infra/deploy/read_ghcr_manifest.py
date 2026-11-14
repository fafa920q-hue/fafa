#!/usr/bin/env python3
"""Validate a GHCR release manifest and print the image pull list.

The deploy script (infra/scripts/deploy-production.sh) no longer builds
images on the host. It pulls them from a registry by the fixed registry
MANIFEST digest recorded in deployments/ghcr-images.json,
then tags them locally. This helper is the single place that parses and
validates the manifest, so a missing field, a bad digest, a wrong registry
or a wrong image name fails the deploy before any service is stopped.

Manifest format::

  {
    "image_tag_sha": "baf523c10aa448cc0bddbce1f37948350f94af59",
    "registry": "ghcr.io",
    "images": {
      "runtime": {"image": "ghcr.io/fafa920q-hue/fafa-runtime", "digest": "sha256:<64 hex>"},
      "web":     {"image": "ghcr.io/fafa920q-hue/fafa-web",     "digest": "sha256:<64 hex>"},
      "admin":   {"image": "ghcr.io/fafa920q-hue/fafa-admin",   "digest": "sha256:<64 hex>"}
    }
  }

The registry MANIFEST digest is what is pulled; it is an immutable, exact
image identity (it is what docker build-push-action reports and what
`docker push` prints). The image CONFIG digest (docker image Id) is a
different hash for the same image and is what the deploy script records in
deployments/<deployment_sha>-images.json and verifies against the running
containers. Do not confuse the two.

Allowed registries come from DEPLOY_IMAGE_REGISTRIES (space-separated,
default "ghcr.io"). The isolation harness sets it to its local registry
(e.g. "127.0.0.1:5001"). For ghcr.io the image must be
fafa920q-hue/fafa-<target>; for a local registry it must be fafa-<target>.

Usage: read_ghcr_manifest.py <manifest.json>
Stdout (only after all validation passes, one line each)::

  registry <host>
  image_tag_sha <40-hex>
  pull runtime <image>@<digest>
  pull web <image>@<digest>
  pull admin <image>@<digest>

Exit: 0 on success, 1 on any validation error (message on stderr).
"""

import json
import os
import re
import sys

TARGETS = ("runtime", "web", "admin")
MANIFEST_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def die(message):
    print(f"MANIFEST_ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def main(argv):
    if len(argv) != 2:
        die("usage: read_ghcr_manifest.py <manifest.json>")
    manifest_path = argv[1]
    try:
        with open(manifest_path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as exc:
        die(f"cannot read manifest {manifest_path}: {exc}")
    if not isinstance(manifest, dict):
        die("manifest must be a JSON object")

    image_tag_sha = manifest.get("image_tag_sha")
    if not isinstance(image_tag_sha, str) or not COMMIT_SHA_RE.match(image_tag_sha):
        die("image_tag_sha must be a 40-character lowercase hex commit SHA")

    registry = manifest.get("registry")
    allowed = os.environ.get("DEPLOY_IMAGE_REGISTRIES", "ghcr.io").split()
    if not isinstance(registry, str) or registry not in allowed:
        die(f"registry {registry!r} is not in the allowed list {allowed}")

    images = manifest.get("images")
    if not isinstance(images, dict):
        die("images must be an object with runtime, web and admin entries")
    if set(images) != set(TARGETS):
        die(f"images must contain exactly runtime, web and admin (got {sorted(images)})")

    lines = []
    for target in TARGETS:
        entry = images[target]
        if not isinstance(entry, dict) or set(entry) != {"image", "digest"}:
            die(f"images.{target} must be an object with exactly image and digest")
        image = entry["image"]
        digest = entry["digest"]
        # Reject a tag. A registry may itself carry a port (127.0.0.1:5001),
        # so only the last path component is checked for a colon.
        if not isinstance(image, str) or ":" in image.rsplit("/", 1)[-1]:
            die(f"images.{target}.image must be a repository reference without a tag")
        if not isinstance(digest, str) or not MANIFEST_DIGEST_RE.match(digest):
            die(f"images.{target}.digest must be sha256:<64-hex>")
        if registry == "ghcr.io":
            expected = f"ghcr.io/fafa920q-hue/fafa-{target}"
        else:
            expected = f"{registry}/fafa-{target}"
        if image != expected:
            die(f"images.{target}.image must be {expected} (got {image!r})")
        lines.append(f"pull {target} {image}@{digest}")

    print(f"registry {registry}")
    print(f"image_tag_sha {image_tag_sha}")
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

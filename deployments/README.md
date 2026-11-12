# Deployments

This directory holds one record per deployment. `infra/scripts/deploy-production.sh`
writes `deployments/<deployment_sha>-*.json` for every run (image digests,
service state, migrations, owner).

## GHCR release manifest

Since the stage H digest-pull rewrite (2026-11-13) the production host no
longer builds images. `deploy-production.sh` pulls them from GHCR by the
fixed registry MANIFEST digest listed in
`deployments/ghcr-images.json`, then tags them locally with
the deployment SHA. A deployment SHA is the commit that carries its manifest
(it descends from the commit the images were built from).

Format:

```json
{
  "image_tag_sha": "baf523c10aa448cc0bddbce1f37948350f94af59",
  "registry": "ghcr.io",
  "images": {
    "runtime": {
      "image": "ghcr.io/fafa920q-hue/fafa-runtime",
      "digest": "sha256:<64 hex>"
    },
    "web": {
      "image": "ghcr.io/fafa920q-hue/fafa-web",
      "digest": "sha256:<64 hex>"
    },
    "admin": {
      "image": "ghcr.io/fafa920q-hue/fafa-admin",
      "digest": "sha256:<64 hex>"
    }
  }
}
```

- `image_tag_sha`: the commit the images were built from (the tag the
  `release-images.yml` workflow put on them). Traceability only; the pull
  is pinned by `digest`.
- `digest`: the registry MANIFEST digest reported by
  `docker/build-push-action` (`image-digest-<target>.json`) and recorded in
  the workflow artifacts. It is the identity used for the pull.
- The image CONFIG digest (`docker image Id`) is a _different_ hash for the
  same image. `deploy-production.sh` records it in
  `deployments/<deployment_sha>-images.json` and verifies the running
  containers against it. Do not confuse the two.

The manifest is validated by `infra/deploy/read_ghcr_manifest.py` before
anything is pulled: allowed registries (default `ghcr.io`; the isolation
harness may set `DEPLOY_IMAGE_REGISTRIES` to a local registry), image names
(`ghcr.io/fafa920q-hue/fafa-<target>`), and `sha256:<64 hex>` digests.

## Creating a manifest (after a GHCR build)

1. Dispatch `.github/workflows/release-images.yml` (`workflow_dispatch`,
   `candidate_sha` = the release commit, `run_tests` = true).
2. When it completes, download the `release-image-digest-<target>` artifacts
   and read each image's manifest digest.
3. Write `deployments/ghcr-images.json` in the release commit, with
   `image_tag_sha` = the release commit and `digest` = the digest from
   each artifact. Commit the file and only then deploy that commit.

A missing or invalid manifest fails the deploy with `PRE_DEPLOY_FAIL`
before any service is stopped.

## GHCR token

For `ghcr.io` the deploy requires a read-only token at
`/run/fafa-one/secrets/ghcr_token`, checked like the Resend mail secret:
regular file (not a symlink), mode `400`, owned by uid `1000`, on tmpfs.
The deploy logs in, pulls, and logs out again so the credential does not
persist in the Docker config. The token is never printed or logged.

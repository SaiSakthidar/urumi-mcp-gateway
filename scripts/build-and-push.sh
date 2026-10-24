#!/usr/bin/env bash
# Build multi-arch images (amd64 + arm64, so ARM VPSes work too) and push them.
#
#   ./scripts/build-and-push.sh ghcr.io/<user> 0.1.0
#
# Images are named <registry>/urumi-<app>:<tag>, matching values-prod.yaml.
# Log in first: echo $GITHUB_TOKEN | docker login ghcr.io -u <user> --password-stdin
set -euo pipefail
REGISTRY="${1:?registry, e.g. ghcr.io/<user>}"
TAG="${2:?tag, e.g. 0.1.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for app in woo-mcp gateway dashboard everything-mcp; do
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$REGISTRY/urumi-$app:$TAG" \
    --push \
    "$ROOT/apps/$app"
done
echo "Pushed $REGISTRY/urumi-*:$TAG"

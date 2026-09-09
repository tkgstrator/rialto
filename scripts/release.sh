#!/bin/bash
set -e

# Release script — Docker only now that the npm CLI package and the
# packages/core npm publish flow have been retired. Publishes the
# consolidated Vite + Hono image to GHCR.
#
# Paths resolve from the script's own location, not from the caller's
# working directory. They used to be `../package.json` and `-f ../Dockerfile ..`,
# written when this lived beside `packages/core` and ran from inside a
# package. After the flatten there is nothing above the repo root, so
# `bun run release` — which runs from the root, as package.json declares —
# died on `require('../package.json')` before it reached Docker at all.
#
# This is a manual path. The shipped release is built by
# `.github/workflows/docker-publish.yml` on a `v*.*.*` tag; this script
# is for building and pushing the same image by hand.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION=$(node -p "require('${ROOT}/package.json').version")
IMAGE_NAME="ghcr.io/tkgstrator/rialto"
IMAGE_TAG="${VERSION}"
LATEST_TAG="latest"

PUBLISH_TYPE="${1:-docker}"

if [ "$PUBLISH_TYPE" != "docker" ] && [ "$PUBLISH_TYPE" != "all" ]; then
  echo "Usage: $0 [docker|all]"
  exit 1
fi

echo "Releasing Rialto v${VERSION}"

if ! docker info &>/dev/null; then
  echo "Error: Docker is not running"
  exit 1
fi

# GHCR needs a token with write:packages; `gh auth token` carries it when
# the CLI was authenticated with that scope. This is the manual path, so
# fail loudly here rather than at push time after a full image build.
if ! docker login ghcr.io -u "$(gh api /user --jq .login)" --password-stdin <<<"$(gh auth token)" &>/dev/null; then
  echo "Error: could not log in to ghcr.io — check 'gh auth status' has write:packages"
  exit 1
fi

docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" -f "${ROOT}/Dockerfile" "${ROOT}"
docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${LATEST_TAG}"
docker push "${IMAGE_NAME}:${IMAGE_TAG}"
docker push "${IMAGE_NAME}:${LATEST_TAG}"

echo "Released ${IMAGE_NAME}:${IMAGE_TAG} (+ :latest)"

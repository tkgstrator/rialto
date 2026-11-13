#!/bin/sh
# Container entrypoint: apply pending Prisma migrations BEFORE the server
# boots. src/index.ts assumes the schema already exists — against an
# unmigrated database it would throw P2021.
#
# `prisma migrate deploy` is idempotent (it applies only pending
# migrations), so running it on every container start is safe.
#
# `set -e` makes a failed migration abort the container instead of
# starting the server against a half-initialised DB. compose.yaml
# already gates this on `postgres: condition: service_healthy`.
set -e

# The @openai/codex dev package is not in the runtime image, so its
# version is baked at build time; codex-credentials reads it via this
# env (falls back internally if unset).
if [ -f /app/.codex-cli-version ]; then
  CODEX_CLI_VERSION="$(cat /app/.codex-cli-version)"
  export CODEX_CLI_VERSION
fi

# prisma is a runtime dependency (installed locally; prisma.config.ts
# imports `prisma/config`), so this resolves the local, lockfile-pinned
# CLI — no network fetch.
echo "[entrypoint] applying prisma migrations (migrate deploy)..."
bunx prisma migrate deploy
echo "[entrypoint] migrations applied; starting server"

exec "$@"

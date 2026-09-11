# Production image for the consolidated Vite + Hono app.
#
# Multi-stage: the builder carries devDependencies (vite, prisma CLI,
# @openai/codex, …) to build the SPA + generate the Prisma client; the
# runtime image installs production deps only, so none of that ships.
#
# Runtime executes TS source directly with Bun (no dist server bundle):
# `bun --tsconfig-override tsconfig.runtime.json src/index.ts`, so the
# image still needs src/, the prod node_modules, the generated Prisma
# client and the Vite SPA dist.

# ---------- builder ----------------------------------------------------
FROM oven/bun:1.4.2 AS builder
WORKDIR /app

# Order matters: prisma.config.ts + src/prisma/schema.prisma must be in
# place before `bun install` (package.json postinstall runs
# `prisma generate`).
COPY package.json bun.lock ./
COPY tsconfig.json tsconfig.base.json tsconfig.runtime.json biome.json ./
COPY index.html vite.config.mts prisma.config.ts ./
COPY scripts ./scripts
COPY src ./src

# Retry once: bun's tarball extraction (large @electric-sql/pglite, pulled
# via prisma → @prisma/dev) is intermittently flaky under QEMU arm64.
RUN bun install --frozen-lockfile || bun install --frozen-lockfile
RUN bunx prisma generate
RUN bun run build

# Bake the Codex CLI version while @openai/codex (dev-only) is present;
# it is NOT in the runtime image, so codex-credentials reads this via
# CODEX_CLI_VERSION (exported by the entrypoint). Never fail the build.
RUN bun -e "let v='';try{v=require('@openai/codex/package.json').version}catch{};require('fs').writeFileSync('/app/.codex-cli-version',v)"

# ---------- runtime ----------------------------------------------------
FROM oven/bun:1.4.2
WORKDIR /app

# Sources needed to resolve + run.
COPY package.json bun.lock ./
COPY tsconfig.json tsconfig.base.json tsconfig.runtime.json biome.json ./
COPY prisma.config.ts ./
COPY src ./src

# Production deps only — drops vite, @openai/codex, biome, typescript,
# playwright, … `prisma` is a runtime dep (the entrypoint runs
# `prisma migrate deploy` and prisma.config.ts imports `prisma/config`),
# Scripts are skipped here (the generated client is copied from the
# builder below) and the built SPA also comes from the builder.
# --frozen-lockfile matches the builder: bun.lock is authoritative after
# the CDN tarball hashes were re-aligned (commit e98a703). Retried once for
# the same QEMU arm64 tarball-extraction flakiness as the builder stage.
RUN bun install --production --frozen-lockfile --ignore-scripts \
    || bun install --production --frozen-lockfile --ignore-scripts

# Build outputs the production-only install does not reproduce.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated
COPY --from=builder /app/.codex-cli-version ./.codex-cli-version

COPY entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The codex OAuth callback listener (src/services/codex-auth/callback-listener.ts).
# OpenAI's client whitelists http://localhost:1455/auth/callback and nothing
# else, so the port cannot be remapped inside the container — and a loopback
# bind would be invisible to Docker's published-port proxy, which connects to
# the container's external interface. Publish it as `127.0.0.1:1455:1455` to
# keep it off the LAN while the browser on the Docker host can still reach it.
# Deployments where the browser is elsewhere finish through the paste box in
# Providers -> Connect instead; this port is not needed there.
ENV CODEX_CALLBACK_HOST=0.0.0.0

EXPOSE 3456 1455

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3456/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "--tsconfig-override", "tsconfig.runtime.json", "src/index.ts"]

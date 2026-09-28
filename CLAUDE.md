# CLAUDE.md

Guidance for Claude Code in this repository. Kept short on purpose: the design lives in `docs/`,
and this file only holds what the code will not tell you.

## What Rialto is

A routing gateway. It accepts several LLM wire formats inbound and dispatches each request to an
upstream vendor — API keys, or Claude / Codex / Gemini subscriptions over OAuth. One package: a
Hono server plus a React SPA built by Vite, Postgres through Prisma. There are no workspaces, no
CLI (`package.json` has no `bin`; the old `ccr` / `rialto` commands are gone), and no
`@musistudio/llms` dependency (absorbed into `src/llms/`).

## Rules

- **Never edit `src/components/ui/`** — shadcn owns it; update with
  `bunx shadcn@latest add <component> --overwrite`.
- **Never edit or grep `src/generated/`** — the Prisma client, which inlines the whole schema as one string.
- **Do not start a dev server.** One is normally already running on :16175.
- bun and bunx only, never npm / npx.
- Code comments in English, explaining *why*. `src/prisma/schema.prisma` and `src/llms/` are the house style.
- New documentation goes under `docs/`, not the repo root.
- `src/shared/` is bundled into the browser: nothing there may import Node built-ins, Prisma or `src/services/`.
- There is no `@/schemas` barrel. Import from the layer: `@/schemas/domain/provider`, `@/schemas/wire/...`.

## Layout

| Path | Contents |
|---|---|
| `src/index.ts` | Hono entry: `/api/*`, the inbound surfaces, `/codex`, `/health`, the OAuth `/callback` |
| `src/api/` | One `route.ts` per endpoint, Next.js-style directories |
| `src/llms/` | Transformers, request pipeline, router, tokenizers, inbound-surface descriptors |
| `src/services/` | Config, OAuth, usage, routing scheduler, access tokens, model sync |
| `src/vendors/` | Per-vendor model-list and price adapters. Never on the request path |
| `src/schemas/` | Zod in four layers: `primitives / wire / domain / api` |
| `src/components/rialto/` | The UI screens |
| `src/prisma/schema.prisma` | Its column comments are the data-model documentation |
| `__tests__/` | Mirrors `src/` |
| `mocks/` | Human-approved static HTML mocks — the implementation target for UI work |
| `docs/architecture/` | Inbound surfaces, routing, pipeline, request flow, testing map |

## Commands

```bash
bun run dev             # Vite on :16175 (SPA + the Hono app). Usually already running.
bun run build
bunx tsc --noEmit
bunx biome check --write src __tests__
bunx knip               # dead code

bun test                # full suite. CI runs: RIALTO_SKIP_LIVE_TESTS=1 bun test __tests__/
bun run test            # only __tests__/lib, db, preset — NOT the full suite
bun run test:e2e        # against the running dev server; skips itself when :16175 is down
bun run db:migrate:test # after any Prisma migration
```

- Tests that touch Postgres use the separate `rialto_test` database. If they fail with
  `TableDoesNotExist`, that database is behind: run `bun run db:migrate:test`.
- `bun install` needs `GH_TOKEN` with `read:packages`: the `@qtmleap` scope comes from GitHub
  Packages (`bunfig.toml`). `.envrc` fills it from `gh auth token`.

## Code style

Biome, plus GritQL rules in `biome-plugins/` (a git submodule; see its README). They report as
warnings but are the house rules:

- No `??`, no `|| ''` / `|| []` style fallbacks, no `let`, no `while`, no type assertions.
- No `new Date()` — use dayjs (`src/lib/dayjs`).
- Zod: no bare `z.string()` (say `.nonempty()`, `z.uuid()`, `z.url()`), no optional or nullable
  booleans and arrays, `safeParse` over `parse`.
- TypeScript is strict. Derive types with `z.infer` instead of writing an interface beside a schema.

## Things that are easy to get wrong

- **Inbound surfaces** are one descriptor each in `src/llms/inbound/surfaces.ts`. Adding a surface
  should mean adding one descriptor; if it takes edits in several files, knowledge has leaked out
  of it. `docs/architecture/inbound-surfaces.md`.
- **Routing mode** is stored per surface, `routed` or `passthrough`, and a fresh install starts in
  passthrough. `docs/architecture/routing.md`.
- **`/codex` is not an inbound surface.** It is the Codex MCP server, reached with its own
  `codex-mcp` token scope. `docs/guides/codex-mcp.md`.
- **Subagent tag**: `<RIALTO-SUBAGENT-MODEL>` in the second system block selects the scenario's
  subagent lane; only its presence is read. The legacy `<CCR-SUBAGENT-MODEL>` spelling must stay
  accepted (`SUBAGENT_TAGS` in `src/llms/router/request-signals.ts`).
- **Three things are called "provider"**: the Prisma `Provider` row (an upstream you can route to),
  `src/llms/registry/provider.ts` (the runtime registry, on the request path), and `src/vendors/`
  (catalog and pricing only).
- **There is no preset feature.** `src/schemas/domain/preset.ts` only holds the JSON value schemas;
  the name is historical. Do not build on it.

## UI work

Screens are built against `mocks/` and checked by screenshot diff — use the `ui-mock-diff` skill
(`bun run mocks:css | mocks:serve | mocks:shoot | mocks:diff`). The Mock Diff Viewer is at
http://localhost:16175/mock-diff/.

## Git flow

- `feature → develop → master`. Feature PRs target `develop` and are squash-merged; merging into
  `develop` deploys the development environment. Only `develop` may open a PR into `master`
  (`pr-base-guard.yaml`); that is the release.
- Commit messages follow `.commitlintrc.yaml` (`ui` and `format` are valid types); header, body and
  footer lines at most 128 characters.
- Do not bump the version in a feature PR. Bumps are their own `chore: bump version to X.Y.Z` PR.

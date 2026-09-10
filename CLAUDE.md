# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- **NEVER edit `src/components/ui/*.tsx`** — these are managed by shadcn and must only be updated via `bunx shadcn@latest add <component> --overwrite`.

## Project Overview

Rialto is a **routing gateway**: it accepts several LLM wire formats on the inbound
side and dispatches each request to one of several vendors upstream. The name
"Claude Code Router" is retired — it described a `/v1/messages` proxy, which is now
only one of four inbound surfaces.

**This is a single package, not a monorepo.** `package.json` declares no
`workspaces` and there is no `packages/` directory — all source is under `src/`.
There is also **no CLI**: `package.json` has no `bin` field, so the `ccr` / `rialto`
shell commands that older documentation described do not exist. `@musistudio/llms`
is not a dependency either; that code was absorbed into `src/llms/`.

| Path | Contents |
|---|---|
| `src/index.ts` | Hono (`OpenAPIHono`) entry. Mounts `/api/*`, the inbound surfaces, `/health`, and the OAuth loopback `/callback` |
| `src/api/` | One `route.ts` per endpoint, Next.js-style directory naming (`providers/[name]/models/[model]/route.ts`) |
| `src/llms/` | Transformers, request pipeline, `scenario-router`, `quota-router`, tokenizers, inbound-surface descriptors |
| `src/services/` | config, OAuth, usage, routing-scheduler, access tokens, model tests |
| `src/vendors/` | Per-vendor catalog + pricing adapters (`VendorProvider`): fetch a vendor's live model list, scrape its published prices, read per-model context windows. Read by `model-sync-service` / `catalog-service`, **never on the request path**. Named `vendors` and not `providers` because `src/llms/registry/provider.ts` is a different thing — see below |
| `src/schemas/` | Zod, split into four layers — `primitives / wire / domain / api`. There is **no** global `@/schemas` barrel; import from the layer. `wire` / `domain` / `api` each expose one; `primitives` has no barrel because nothing composes the layer as a whole — import `primitives/record` and friends by name |
| `src/components/rialto/` | The UI — six screens (Overview / Routing / Providers / Access tokens / Activity / Settings). Access tokens is top level, beside Providers: Providers is outbound, it is the same question inbound. Settings → Access keeps only admin access |
| `src/components/ui/` | shadcn components. Never edit (see Rules) |
| `src/app/` | React entry point and the `react-router-dom` route table |
| `src/shared/` | Code shared by the server and the browser bundle — must not import server-only modules |
| `src/prisma/schema.prisma` | Prisma schema. The column comments are the real documentation for the data model |
| `src/generated/prisma/` | Generated Prisma client. Never edit, never grep (it inlines the whole schema as one string) |
| `public/` | Copied to `dist/` untouched: the PWA manifest, service worker and icons. Referenced by absolute path, never imported — see `docs/guides/pwa.md` |
| `__tests__/` | Mirrors the `src/` tree |
| `mocks/` | Human-approved static HTML mocks. These are the implementation target for the UI, not throwaway sketches |
| `docs/plan/rialto/master-plan.md` | The refactor plan and its phase-by-phase tracking table |
| `docs/architecture/` | Inbound surfaces, pipeline, request flow, testing map |

## Commands

```bash
bun run dev            # Vite on :16175. Serves the SPA, and via @hono/vite-dev-server
                       # the Hono app for /api/*, /v1/*, /health and /callback.
                       # A dev server is usually already running — do not start a second.
bun run build          # vite build (single-file output)
bun run release        # build + scripts/release.sh docker

bun test               # FULL test suite
bun run test           # ONLY __tests__/lib __tests__/db __tests__/preset — a narrow subset
bun run test:providers # provider contract tests (fixture replay)
bun run test:e2e       # browser tests against the ALREADY-RUNNING dev server
                       # (__tests__/e2e). Skips itself when :16175 is not
                       # answering or playwright has no chromium, so it is
                       # safe in `bun test` and in CI. Never starts a server.
bun run browser:install # playwright's chromium, for test:e2e and mocks:shoot.
                       # Not a postinstall — both skip cleanly without it.

bunx tsc --noEmit      # type check
bunx biome check --write .
bunx knip              # dead-code inventory
```

`bun test` and `bun run test` are **not** the same command. CI runs five jobs:
Commit Lint / Biome Check / Type Check / Test / Build (`.github/workflows/ci.yml`).

UI mock workflow (see `.claude/skills/ui-mock-diff/SKILL.md`):

```bash
bun run mocks:css      # compile mocks/_shared/mock.css with the project's own Tailwind
bun run mocks:serve    # http://localhost:16176/mocks/index.html
bun run mocks:shoot    # screenshot mock + implementation at deviceScaleFactor 2
bun run mocks:diff     # pixel diff. Judge by report.json's `regions`, not the headline %
```

## Core Architecture

### 1. Inbound Surfaces

Everything a request's entry point needs to know lives in one **descriptor**
(`src/llms/inbound/surfaces.ts`): mounted path, auth scheme, error-envelope shape,
SSE aggregator, `inboundType`, model/stream extraction, and default routing mode.
This knowledge used to be spread across four files, where forgetting one of them
broke a surface silently.

| id | path | endpoint | inboundType | auth | errorShape |
|---|---|---|---|---|---|
| `anthropic-messages` | `/v1/messages` | `/v1/messages` | `anthropic` | `x-api-key` | `anthropic` |
| `openai-chat` | `/v1/chat/completions` | `/v1/chat/completions` | `openai` | `bearer` | `openai` |
| `openai-responses` | `/v1/responses` | `/v1/responses` | `openai` | `bearer` | `openai` |
| `gemini-generate` | `/v1beta/models/*` | `/v1beta/models/:modelAndAction` | `gemini` | `google` | `google` |

`GET /v1/models` is a catalog read rather than a completion surface, so it is
deliberately absent from the surface registry. It still has to answer in the OpenAI
SDK's auth convention and error envelope, which is why it sits in `CATALOG_PATHS`
in the same file.

**Routing mode is not a descriptor field.** There is no `defaultRoutingMode` — a
per-surface default made the UI explain which of two identical values was "the
shipped one". Every surface has one explicit stored mode in `InboundSurfaceConfig`,
seeded at boot by `ensureInboundSurfaces()` from the single
`INITIAL_ROUTING_MODE = 'passthrough'`. Passthrough is the seed because routing an
unconfigured install does nothing useful: with no chain the selector falls straight
through to the caller's own model. **A fresh install does not route `/v1/messages` —
turn it on in Routing.**

Adding a surface should mean adding one descriptor. If you find yourself editing
several files to add one, knowledge has leaked back out — put it in the descriptor.
Details: `docs/architecture/inbound-surfaces.md`.

### 2. Routing System

**Two modes, one selector.** Every inbound surface stores one `routingMode`, and a
request is either **routed** through the chain or **passed through** untouched.
Nothing else picks a model: there is no per-scenario slot table, no rule stack, no
custom router hook and no peer injection. The operator says which models and in what
order; the scheduler computes the weights. Nothing in the UI writes a weight.

**Chain** (`routingMode = 'routed'`). `routeScenario` (`src/llms/scenario-router.ts`)
resolves the profile — the authenticating token's `profileKey` wins, else the surface's
`profileKey`, else `DEFAULT_PROFILE_KEY = 'live'` — loads its `RouterPreferenceProfile`
/ `RouterPreferenceEntry` rows once (`loadRoutableProfile`), classifies the request into
a scenario and a lane, and asks the selector for a primary and the rest of the chain:

- **`quota-router`** (`src/llms/quota-router/`) — the selector. Walks the ordered
  entries for `(scenario, lane)`, skipping entries the scheduler snapshot says are
  exhausted, that fail the tier / error-rate / context-window gates, or that are
  switched off. `chainRoutingOf` projects the same loaded profile into what the
  classifier needs before the selector runs (which lanes have a routable entry, the
  default lane's context window, the pinned threshold).
- **`routing-scheduler`** (`src/services/routing-scheduler/`) — computes and
  publishes the weights that walk rides on, one tick at a time. Always runs.
- `src/llms/scenario-router/` — the primitives: `classifyRequest` (subagent tag →
  lane, then scenario), tier inference, `applyProactiveFailover`, persona injection.
  The directory name is left over from when it also hosted a second selector.
- `src/api/v1/` — `buildRoutePlan` runs the router once per request;
  `buildFailoverChain` orders `[primary, ...fallbacks]` minus exhausted marks;
  `attemptChainEntry` walks it, rotating subscription accounts inside one entry on
  429 before moving to the next.

**The chain's order is followed as written.** There is no `auth_mode` gate any more: a
subscription primary keeps its api_key fallbacks, and a same-provider fallback is
legitimate because exhaustion is marked per `(provider, model)`. An entry the operator
did not want after a subscription would not be in the list.

**What happens when the chain has nothing.** The contract, pinned by
`__tests__/llms/route-scenario-chain.test.ts`:

| Situation | `body.model` | Response |
|---|---|---|
| Lane has entries, every one gated, profile `exhaustedBehavior = '429'` (the default) | untouched | 429 + `Retry-After` from `buildRoutePlan`, no upstream dispatch |
| Lane has entries, every one gated, `exhaustedBehavior = 'passthrough'` | untouched, `resolvedFallbacks = []` | goes upstream as the caller sent it |
| Lane has **no entries** | untouched, no fallbacks. **Never a 429**, whatever `exhaustedBehavior` says — the empty-lane shortcut in `quota-router/runtime.ts`: an unconfigured lane is "no opinion", not "everything is exhausted" | goes upstream as the caller sent it |
| Chain fails to load (Postgres away), or routing throws | untouched; logged at `error`; stamped `scenarioType = 'default'`, `isSubagent` from the tag, fallbacks `[]` | goes upstream as the caller sent it |

`routeScenario` never invents a target: `body.model` is only ever rewritten to a chain
entry. A bare model name that reaches the chain walker this way is resolved to the one
enabled provider hosting it (`src/api/v1/invocation.ts`), or refused.

**Passthrough** (`routingMode = 'passthrough'`, or a token whose `profileKey` is the
reserved `PASSTHROUGH_PROFILE_KEY = 'passthrough'`). The caller's own `body.model` goes
upstream — `provider,model`, or a bare name hosted by exactly one enabled provider.
Classification, the chain and proactive failover are skipped; `passthroughDenial` may
refuse a `provider,model` the surface's `deniedTargets` lists. The reserved key is not
a stored profile and cannot hold a chain (`applyRouterPreferences` refuses it).

**Disabled targets are never dispatched, on any path.** `buildLlmsContext` builds the
provider registry and the `providers` view the router reads from enabled providers and
enabled models only — the same predicate `/v1/models` advertises (`getEnabledModels`),
so the menu and the door agree. `loadRoutableProfile` folds `Model.enabled &&
Provider.enabled` into each entry's `enabled`, so the selector, the classifier's lane
gate and the scheduler cannot disagree on whether a switched-off model is "in the
chain"; `resolveInvocationForModel` returns null for a pair outside the registry; and
the per-request subscription account pool (`subscription-account-sync/read.ts`) filters
`Provider.enabled`. A `provider,model` naming a disabled or uncatalogued model is
refused, not forwarded. `loadRouterPreferences` — what the Routing screen reads — keeps
the two switches apart as `targetEnabled`, so the editor can show an entry whose target
is off without pretending the entry itself was.

**There is no `ROUTER_MODE`.** It, `ROUTER_SHADOW` and `ROUTER_ROLLOUT_PCT`
selected between two selectors and moved traffic between them a percentage at a
time; that migration is over. A stale value on disk is preserved by
`ConfigEnvelopeSchema`'s `.catchall` and read by nothing.

**There are no routing rules, slots, presets or override files.** The first-match
`rules[]` stack, the `RouterSlot` table and the `Router` config object that projected
it, the `RoutingPreset` snapshots (`/api/routing-presets`, the built-in tier presets,
the Routing screen's Presets menu), the per-project / per-session `Router` override
files under `~/.rialto/<project>/`, `CROSS_PROVIDER_FALLBACK` same-model peer
injection, `CUSTOM_ROUTER_PATH` and `LiveRoutingName` all went with the selector that
owned them (migration `20260910095324_drop_router_slot_and_routing_preset`; the slots
are deliberately **not** backfilled into the chain). `POST /api/config` drops the
retired keys with a warning and prunes them from disk on the next save
(`RETIRED_ENVELOPE_KEYS` in `src/services/config/compose.ts`). Routing is one screen.

Scenarios are the `ScenarioKey` enum: `default` / `think` / `longContext` /
`webSearch` / `image`. **`background` is gone** — it was folded into `default`
(migration `20260728_router_rules_drop_background`). A scenario is only chosen when
the chain has a routable entry for it on the request's lane (`ChainRouting.hasLane`);
otherwise the request lands on `default`.

Two independent lanes exist per scenario: `agent` (ordinary traffic) and `subagent`
(requests carrying a subagent tag — see Subagent Routing below).

Token estimation for the `longContext` scenario goes through `src/llms/tokenizers/`,
which has a tiktoken backend and a model-accurate `@huggingface/tokenizers` backend.
A `tool_result`'s array content is walked block by block, so an image or document
payload nested in a tool result weighs nothing — the same as a top-level image block.
Serialising it as text once made one screenshot count as a million tokens and pushed
every later request in that session into `longContext`.

The `longContext` threshold is **not a fixed 60 000**. `effectiveLongContextThreshold`
(`src/llms/scenario-router/model-selection.ts`) takes the profile's
`constraints.longContextThreshold` when one is set (a positive integer; `null` means
auto; edited on the Routing screen and round-tripped through `/api/router-preferences`);
otherwise it is 70 % of the `contextWindow` of the chain's top routable `default` /
`agent` entry (`LONG_CONTEXT_AUTO_RATIO`), leaving headroom for the reply; and only when
neither resolves does it fall back to `DEFAULT_LONG_CONTEXT_THRESHOLD = 128_000`. The
migration copied a numeric threshold off the old `longContext` slot onto the `live`
profile's constraints.

**There is no weekly drain guard on the request path any more.**
`applyProactiveFailover` (`src/llms/scenario-router/failover.ts`) walks
`[primary, ...fallbacks]` against two gates only — the exhaustion marks written by the
reactive 429 path, and the context-window capability gate. Subscription providers run
to their upstream limit and are rotated reactively. `getKindWindowHeadroom` /
`drainTarget` still exist in `src/services/usage-service/`, but nothing on the request
path calls them — the only callers left are tests.

### 3. Transformer System

Transformers adapt Anthropic-format requests to each provider's wire format. Six ship with the app and are registered in `src/llms/context.ts` (implementations in `src/llms/transformers/`):

`anthropic`, `openai`, `openai-responses`, `gemini`, `claude-code-oauth`, `codex-oauth`

There is no plugin loader: the set is fixed at build time, and a provider's transformer chain is **derived**, not configured. `src/shared/transformer-chain.ts` maps `Provider.apiStyle` + `Provider.authMode` to the chain; `ProviderRegistry` resolves it to instances, and the Providers screen's read-only "Request shape" block displays it by calling **the same function**, so what is shown cannot drift from what runs. `Provider.transformer` is gone entirely — not emptied, dropped: no such column exists. What `/api/config` still calls `transformer` is a projection of `Model.enabled` (`{ _disabledModels: [...] }`) that the provider editor reads under the old name. `GET /api/transformers` returns the live registry (name + endpoint).

A model whose `Model.apiStyle` disagrees with its provider's (codex-family models on the api_key OpenAI provider) gets its own conversion step appended after the provider chain.

### 4. SSE and Non-Streaming Aggregation

There are no `SSEParserTransform` / `SSESerializerTransform` / `rewriteStream`
classes — those belonged to the absorbed vendor code and no longer exist.

**Non-streaming aggregation** — when the caller wants one JSON body but the upstream
only speaks SSE, `src/llms/utils/sse-aggregate/` folds the event stream into a single
response. `parse.ts` holds the only shared piece (SSE framing); above it there is one
aggregator per wire vocabulary: `anthropic` / `openai-chat` / `openai-responses` /
`gemini`. **Pick the aggregator from the surface descriptor's `aggregateSse` field,
never by branching on a transformer name.**

**Streaming relay** — each wire format handles its own stream under its vendor
directory (`src/llms/transformers/anthropic/`, `.../openai/`, `.../gemini/`), because
the event vocabularies do not line up.

**Server → browser** — `src/api/request-logs/sse.ts` pushes new-log notifications to
the UI. Its auth is deliberately odd: `EventSource` cannot set headers, so `adminAuth`
accepts an `apikey` query parameter on that one path.

### 5. Configuration Management

The Rialto rename is complete: the pre-rename names below are **no
longer read**. Anything still using one has to be updated.

| Old | New | Notes |
|-----|-----|-------|
| `CCR_HOME_DIR` | `RIALTO_HOME_DIR` | ignored; the wrong home announces itself as an empty config |
| `CCR_ACCOUNT_ENCRYPTION_KEY` | `RIALTO_ACCOUNT_ENCRYPTION_KEY` | **rename the variable, keep the value byte-for-byte** — it decrypts existing `SubAccount` rows. `encryptionKey()` throws with that instruction |
| `CCR_DEBUG_OAUTH` | `RIALTO_DEBUG_OAUTH` | ignored |
| `~/.claude-code-router` | `~/.rialto` | moved on first boot by `src/services/config/migrate-home-dir.ts` — copy, verify, then remove the original |
| `ccr_` thinking signatures | `rialto_` | a pre-rename placeholder now reaches Anthropic and 400s that conversation; restart it |
| `ccrVersion` (preset manifests) | `rialtoVersion` | moot — the manifest schemas are gone from `src/schemas/domain/preset.ts`, nothing parses either spelling |
| DB `ccr` / `ccr_test` | `rialto` / `rialto_test` | fresh volumes are provisioned with the new names; existing ones need `bun run scripts/rename-dev-database.ts`, then `DATABASE_URL` / `TEST_DATABASE_URL` updated |

Configuration is split across two stores:

- **Disk envelope**: `~/.rialto/config.json`. The whitelist is `ConfigEnvelopeSchema` in `src/schemas/domain/config.ts` — read that, not a list here, because it is what boot actually parses. It carries the boot-time scalars (`HOST` / `PORT` / `APIKEY` / `LOG` / `LOG_LEVEL` / `PROXY_URL` / `API_TIMEOUT_MS` / `CLAUDE_PATH` / `NON_INTERACTIVE_MODE`), the archive switches (`CAPTURE_REQUESTS` / `CAPTURE_MESSAGES` / `REDACT_TOOL_ARGUMENTS`), the Cloudflare Access pair (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`), the scheduler tick (`ROUTING_SCHEDULER_INTERVAL_MS`), the active persona's id (`ActivePersona` — also a top-level key on the `/api/config` wire and on the `ConfigStore`), and the disk-resident objects (`Personas`, `StatusLine`). Keys the schema does not declare are preserved by its `.catchall`, not dropped — except the retired routing keys (`Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`), which `RETIRED_ENVELOPE_KEYS` strips on every read and prunes on the next save.
- **PostgreSQL** (via Prisma, `src/prisma/schema.prisma`): everything else. `DATABASE_URL` is loaded from `.env` (`.devcontainer/compose.yaml` provides `postgres` and `redis`).

The schema is well past the three tables the first PR shipped; the column comments in
`src/prisma/schema.prisma` are the documentation. The rows worth knowing here:

| Table | Notes |
|-------|-------|
| `Provider` | unique `name`, `apiBaseUrl`, `apiKey`, `authMode`, `apiStyle`, `enabled`. **No account is designated** — `activeSubscriptionAccountId` is gone (migration `20260910084500_drop_provider_active_subscription_account`); which SubAccount serves a request is decided per request, and "can this provider authenticate" is asked of its accounts as a set (`src/shared/subscription-credential.ts`). **There is no `transformer` column** — the chain is derived (see Transformer System) and the `transformer._disabledModels` the UI reads is synthesized from `Model.enabled` by `toWireTransformer` |
| `Model` | FK to Provider with `onDelete: Cascade`, composite unique `(providerId, name)`, optional per-model `apiStyle` override. `enabled` is the per-model switch; `Provider.enabled` gates the whole provider above it |
| `SubAccount` / `SubAccountUsage` / `SubAccountQuota` | subscription accounts, their observed windows, and the exhaustion state the quota router reads |
| `RouterPreferenceProfile` / `RouterPreferenceEntry` | the ordered chain the `quota-router` walks, per scenario and per `RouterPreferenceKind` lane. `constraints` (JSONB, no DDL to add a knob) holds `exhaustedBehavior`, `longContextThreshold` and the rest; an entry's `model` FK is `onDelete: Cascade`, so the apply layer counts the entries a model or provider deletion takes with it and warns. **There is no `RouterSlot` table** (dropped by `20260910095324_drop_router_slot_and_routing_preset`, together with `RoutingPreset`) |
| `InboundSurfaceConfig` | one row per surface: `routingMode` + `profileKey` + `deniedTargets` |
| `AccessToken` | issued `/v1/*` credentials — sha256 only, optional surface and routing-profile scope |
| `Session` / `Message` / `RequestLog` / `UsageSnapshot` | the archive behind Activity and Overview |

Boot sequence — top-level statements in `src/index.ts`, not a `getServer()`:

1. `migrateHomeDir()` — carry a pre-rename `~/.claude-code-router` over to `~/.rialto`. **Must run first**: the migration is idempotent by "the destination already exists", so any earlier `mkdir` of `~/.rialto` makes the copy a permanent no-op. Skipped when `RIALTO_HOME_DIR` pins the home elsewhere.
2. `initDir()` — ensure home directories.
3. `initConfig()` — read the envelope from disk, mirror scalar keys onto `process.env` via `applyEnvelopeToEnv`, then `syncLoggerFromEnv()` re-applies `LOG_LEVEL` to the already-constructed pino instance.
4. `ensureInboundSurfaces()` — give every registered surface an explicit stored routing mode.
5. `startUsageCapture()` / `startAuthHealthCheck()` / `startRoutingScheduler()` — fire-and-forget background jobs; none of them may block boot.

There is **no `runJsonToDbMigration()`** and no `getServer()`. The one-shot lift of
legacy `Providers` out of `config.json` is gone. The flow now runs the other way:
`syncToConfigFile()` (`src/services/config/sync-to-disk.ts`) writes the DB's
`Providers` **back onto** `config.json` after every CRUD, so that key on disk is a
read-only mirror. Editing it by hand does nothing and is overwritten on the next save.
`Router` is not mirrored at all any more — there is nothing to mirror — and a copy an
older build left on disk is stripped on read and pruned on the next save.
`loadFullConfig()` (`src/services/config/compose.ts`) is still there; it is called
lazily by `buildLlmsContext`, not at boot.

**A fresh install mints no `APIKEY`.** `createDefaultConfig` used to generate one,
which meant every install shipped a master key for `/api/*` that bypasses Cloudflare
Access for whoever finds it. Nothing needs one now — a browser on this machine is
exempt, remote admin goes through Access, and `/v1/*` takes issued tokens. Setting
`APIKEY` by hand is still supported as a deliberate break-glass.

DDL is not created at boot either: `entrypoint.sh` runs `prisma migrate deploy` and
`prisma db seed` before exec'ing the process.

Config API (`src/api/config/route.ts`, service in `src/services/config/`):

- `GET /api/config` returns `composeUiConfig()` (envelope on disk + DB-resident config).
- `POST /api/config` calls `applyUiConfig(body)`: diffs the incoming UI payload inside a single Prisma transaction and returns `{ success, warnings[] }`. A removed model or provider takes its chain entries with it (`RouterPreferenceEntry.model` cascades), so the apply layer counts them **before** the delete and warns with the number per profile / scenario / lane; the retired keys (`Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`) are dropped with a warning and never stored. `ActivePersona` is an ordinary top-level key: `''` / `null` clears it, absent leaves it alone. Envelope keys land on disk via `writeConfigFile` after the DB transaction commits, and `applyEnvelopeToEnv` re-mirrors them onto `process.env` — so envelope changes are hot, without a restart.

Key features (disk envelope):
- Environment variable interpolation (`$VAR_NAME` or `${VAR_NAME}`)
- JSON5 format (supports comments)
- **No backups.** `writeConfigFile` overwrites in place; the only safety net is
  `quarantineConfigFile`, which renames an unparseable config aside instead of
  deleting it. The Advanced screen used to claim "3 backups kept" — it does not now.

There is no `rialto restart`, and no CLI at all. A Docker deployment restarts with
`docker compose restart`; a local one restarts the process. Envelope scalars written
through `POST /api/config` do not need either.

`HOST` defaults to `127.0.0.1` and there is **no validation coupling `Providers` to
`HOST`/`APIKEY`** — that check does not exist. What actually gates access:
`/api/*` takes Cloudflare Access (when `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are both
set) or the envelope `APIKEY`, and exempts a browser on the machine itself
(`src/api/local-access.ts`). `/v1/*` takes **issued `AccessToken`s only** — the
`APIKEY` is rejected there, so an install with no token issued cannot proxy.

Database tooling (`bun run`, from the repo root — there is no `packages/`):

- `db:generate` — regenerate the Prisma client into `src/generated/prisma/`. Also wired as `postinstall` so a fresh `bun install` materialises it.
- `db:migrate` — create + apply a new migration (development).
- `db:migrate:deploy` — apply existing migrations (production / CI).
- `db:migrate:test` — apply them to `rialto_test`. **Separate database; CI fails without it.**
- `db:reset` — drop and recreate the schema (destructive).
- `db:seed` — `src/prisma/seed.ts`; idempotent, creates the `live` preference profile (empty until the operator fills it in). No slot rows — there is no such table — and no placeholder Providers.
- `db:seed:demo` — `scripts/seed-demo-data.ts`; dev-only demo data for every screen (traffic, chains, quota, tokens). Rows it owns carry a `demo-` id and `-- --clean` removes them; live config (the `live` chain and its `longContextThreshold` constraint, surface modes, an account's quota) is written only while unset. Never wired into `db:seed`. See `docs/guides/demo-data.md`.
- `db:studio` — open Prisma Studio.

Never edit DDL directly; always go through Prisma migrations.

### 6. Logging System

Two separate logging systems:

**Server-level logs** (pino):
- Location: `~/.rialto/logs/rialto-*.log`
- Content: HTTP requests, API calls, server events
- Configuration: `LOG_LEVEL` (fatal/error/warn/info/debug/trace)

**Application-level logs**:
- Location: `~/.rialto/rialto.log`
- Content: Routing decisions, business logic events

## Subagent Routing

A subagent tag in the second system block selects the scenario's **`subagent` lane**:

```
<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

**Only the tag's presence is read. Its value is ignored.** `stripSubagentTag`
(`src/llms/scenario-router/request-signals.ts`) returns a boolean and strips the tag
in place so the internal marker never reaches upstream; `classifyRequest` turns that
boolean into the lane, and the selector walks the `subagent` entries of the chosen
scenario instead of the `agent` ones. It does not resolve `provider,model` out of the
tag body — the model comes from the subagent lane's chain, which is what makes the lane
editable in Routing instead of scattered across prompt files. A tag whose body is a
now-deleted `provider,model` pair still routes correctly; it just routes by lane. A
subagent lane with no entries behaves like any empty lane: the caller's own model
passes through.

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still accepted (same file,
`SUBAGENT_TAGS`). It lives in prompts users have already written, and dropping it
would silently reroute that traffic onto the main-agent chain, so it must not be
removed.

Only a well-formed (closed) tag is stripped; a malformed one still counts as present
but is left in the prompt.

## Presets

**There is no preset feature.** Three unrelated things used to carry the name, and
all three are gone — do not build on any of them:

1. **`RoutingPreset`** — named snapshots of the retired `Router` slot config. The
   table, `src/services/routing-preset.ts`, `/api/routing-presets`, the built-in tier
   presets (`shared/data/routing-presets.ts`, `lib/routing-map/`) and the Routing
   screen's Presets menu were removed with the slot selector (migration
   `20260910095324_drop_router_slot_and_routing_preset`). The chain is edited in place
   on the Routing screen; there is nothing to snapshot it into.
2. **`src/lib/presets/`** — the dynamic-input form (`form-logic.ts`, `types.ts`)
   behind a Settings → Presets screen. Both went with that screen; there is no
   `/settings/presets` route in `src/app/routes.tsx`.
3. **The preset manifest schemas** that used to fill `src/schemas/domain/preset.ts` —
   `PresetFileSchema`, `PresetMetadataSchema`, `ConditionSchema` and the rest,
   inherited from the deleted CLI preset installer. Deleted; nothing ever parsed a
   manifest, so the `rialtoVersion` / `ccrVersion` compatibility they carried is moot.

What survives at that path is only the recursive JSON value schema —
`JsonPrimitiveSchema` / `JsonValueSchema` / `JsonObjectSchema` — which backs the
`.catchall` on `schemas/api/config.ts` and `schemas/domain/config.ts` and types the
envelope's `StatusLine`. The file name is historical. `__tests__/preset/schema.test.ts`
stays at its path so `bun run test`'s glob (`__tests__/preset`) is still correct, and
is scoped to those schemas.

`src/shared/preset/` (the dead twin of #2) and the functions older docs describe
(`exportPreset` / `installPreset` / `loadPreset` / `listPresets` / `merge.ts` /
`sensitiveFields.ts`, the `rialto preset *` subcommands) are gone as well. Run
`bunx knip` before building on anything here.

## Dependencies

**Three unrelated things are called "provider".** Do not conflate them.

| | What it is |
|---|---|
| `Provider` (Prisma row) | An upstream Rialto can route to: base URL, key, auth mode, api style, and the `enabled` switch that decides whether Routing offers it at all |
| `src/llms/registry/provider.ts` | The **runtime** registry. Resolves those rows into pipeline-ready objects with their transformer chain, on the request path |
| `src/vendors/` | **Catalog and pricing** adapters, one per vendor. Fetch model lists and scrape prices for the Providers screen and the seed. Never touched while serving a request |

(`src/shared/data/providers/<vendor>/prices.json` is a fourth use of the
word, but it is static scraped output rather than code.)

**Refreshing the catalog** is two buttons on the Providers screen: "Sync models"
(`POST /api/refresh-models`) and "Refresh prices", which is `POST /api/catalog/refresh`
followed by the same refresh. Both end in `refreshModelsForAllProviders`, and what it
can recover comes from three sources that must not be conflated:

- **Which models exist** — the vendor's live `/v1/models` (api_key providers with a
  key; subscription providers have no live list) unioned with the vendor's scrape.
  `VendorCatalog.listed`.
- **Prices** — the live scrape *over* the committed `OFFICIAL_VENDOR_PRICES` table.
  The scrape wins where it answers; the table fills ids it did not mention.
  `VendorCatalog.priceById`, and **only** that field: merging the table into `listed`
  once grew 43 api_key OpenAI models on a Codex subscription, because a price list is
  not a statement about what a provider serves.
- **Context windows** — the vendor's own catalog endpoint (`inputTokenLimit` on
  Google, `max_input_tokens` on Anthropic), or a docs scrape where the endpoint omits
  it (OpenAI). A subscription provider authenticates with its OAuth access token as a
  **bearer with the oauth beta** — an `x-api-key` carrying that token is rejected, so
  the scheme follows the credential rather than the vendor.

Every write is "update what the vendor confirmed, leave the rest alone", so a thin
scrape degrades coverage rather than nulling existing rows.

**Refreshing subscriptions** is a third button, on the Subscriptions list only:
"Refresh" (`POST /api/subscriptions/refresh`, `src/services/subscription-refresh-service.ts`).
It is not a catalog operation and touches no model or price. It re-syncs every account
on an **enabled** subscription provider the way `POST /api/subscriptions/sync` does,
then polls usage with `forceRefresh` past the 5-minute cache in
`src/services/usage-service/cache.ts`, and rewrites the two current-state tables —
`SubAccountUsage` (the account picker) and `SubAccountQuota` (the routing scheduler,
and the list's quota column via `/api/overview`). It deliberately writes no
`UsageSnapshot` row, so the Usage chart stays on the usage job's 5-minute grid; skips
accounts on disabled providers; leaves an account's rows alone when its upstream call
failed and names it in `failed[]` instead; and coalesces concurrent calls into one
upstream pass — there is no cooldown beyond that. `/sync` is unchanged: it still probes
every provider, disabled ones included, because that is what the auth-health job runs.


There is no dependency graph to learn — this is one package. Two rules matter:

- **`src/shared/` is shared with the browser.** Anything imported there ends up in
  the UI bundle, so it must not reach into Node built-ins, Prisma, or `src/services/`.
  `src/shared/transformer-chain.ts` is the model: a pure string mapping with zero
  imports, read by both `ProviderRegistry` on the server and the Providers screen.
- **`@/schemas` as a whole no longer exists.** Import from the layer
  (`@/schemas/domain/provider`, `@/schemas/wire/anthropic/sse`, …). The global barrel
  was deleted precisely because `export *` across 29 files dragged server-only
  schemas into the browser bundle.

## Development Notes

1. **Runtime / package manager**: bun. Use `bun` and `bunx`, never npm/npx.
2. **Formatting and lint**: Biome (`biome.json`, plus local rules in `biome-plugins/`).
   No `??`, no `let`, no type assertions, no `while`. `files.includes` covers
   `src/**` **and `__tests__/**`** — tests were outside it for a long time, which is
   why 22 of them were written in Japanese and a global-shadowing parameter went
   unreported there while the same code in `src/` was an error. `src/components/ui`
   and `src/generated` stay excluded.
3. **TypeScript**: strict. Derive types with `z.infer` rather than hand-writing an
   interface beside a schema.
4. **Code comments MUST be in English**, and should explain *why*, not *what* — the
   existing comments in `src/prisma/schema.prisma` and `src/llms/` are the house style.
5. **Documentation**: when implementing a feature, add to `docs/` rather than
   creating a standalone markdown file at the repo root.
6. **After a Prisma migration**, run `bun run db:migrate:test` as well — the test
   database `rialto_test` is separate and CI will fail without it.
7. **Do not start a dev server.** One is normally already running on :16175.

## Configuration Examples

- Full configuration example: `README.md` (also `README_ja.md` / `README_zh.md`)
- Migration off the pre-rename build, and off the slot / rules / preset routing:
  `docs/guides/migration-v3.md`
- Installed-app / PWA behaviour (display mode, service worker, icons): `docs/guides/pwa.md`
- Public deployment behind Cloudflare Access: `docs/guides/public-deployment.md`

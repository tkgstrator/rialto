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
| `src/llms/` | Transformers, request pipeline, the router (`router.ts` → `tier-router/`), tokenizers, inbound-surface descriptors |
| `src/services/` | config, OAuth, usage, scenario routes and tier aliases, routing-scheduler (quota snapshot, pace, the Long context tuner), access tokens, model tests |
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
| `docs/architecture/` | Inbound surfaces, routing (scenarios and provider tiers), pipeline, request flow, testing map |

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
bun run mocks:config   # regenerate mocks/mock-diff.yaml from mocks/mocks.json
```

The **Mock Diff Viewer** (`mock-diff` sidecar in `.devcontainer/compose.yaml`) shows
the same mocks against their implementations at **http://localhost:16175/mock-diff/**:
the dev server relays that path to it through `@qtmleap/vite-plugin-mock-diff`
(`vite.config.mts`). Its workspace config `mocks/mock-diff.yaml` is generated from
`mocks.json` — edit the registry, run `mocks:config`, commit both;
`__tests__/lib/mock-diff-config.test.ts` fails when they drift. The chosen design per
screen is `mocks/mock-diff.adopted.yaml`, which the viewer writes. The sidecar shares
the app container's network, so it captures the app from loopback and passes the
local-access gate. Mock states chosen by a query string (`routing.html?edit`) load
through the relay, so they capture only while the dev server is up.

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
unconfigured install does nothing useful: with no routes the router falls straight
through to the caller's own model. **A fresh install does not route `/v1/messages` —
turn it on in Routing.**

Adding a surface should mean adding one descriptor. If you find yourself editing
several files to add one, knowledge has leaked back out — put it in the descriptor.
Details: `docs/architecture/inbound-surfaces.md`.

### 2. Routing System

**Two modes, one selector.** Every inbound surface stores one `routingMode`, and a request is
either **routed** — classified into a scenario and a lane, and served from that list — or
**passed through** untouched. Nothing else picks a model: there is no slot table, no rule stack,
no custom router hook and no peer injection, and in routed mode the model name the caller sent
picks nothing. The operator writes which provider tiers serve each scenario and lane, in what
order; the scheduler's pace reading may move a route to the front or the back of the routes that
pass. Reference: `docs/architecture/routing.md`; the design and its reasons:
`docs/plan/scenario-tier-routing.md` (Japanese).

**Routes** (`routingMode = 'routed'`). A route names a provider and a tier, never a model, so a
vendor's new release moves one alias instead of every list that meant it:

- **`TierRoute`** `(profile, scenario, lane, priority) → (provider, targetTier, enabled)`.
  `scenario` is `default` / `think` / `longContext`, `lane` is `agent` / `subagent`, `targetTier`
  is `fable` / `opus` / `sonnet` / `haiku`. A provider's tier appears at most once per list.
- **`ProviderTierAlias`** `(provider, tier) → model` — which model "that provider's sonnet" is
  today. Set on the provider's page; a catalog refresh only lists a newer model as a candidate
  (`isNew`), and promoting it (choosing it in the picker, which also switches the model on) is
  always the operator's call. Claude subscription presets get their aliases automatically when
  their models are created (`ensurePresetAliases`); Codex names no Claude family, so its aliases
  are set by hand.
- Scenarios, lanes and tiers are strings validated by Zod (`src/schemas/domain/tier-route.ts`),
  like `routingMode`, so a new one is a code change, not a migration. `image` and `webSearch` are
  not scenarios: every model worth routing to reads images, and web search is a gate (below).
  Storage: `src/services/tier-route-service.ts` and `src/services/tier-alias-service.ts`.

`routeRequest` (`src/llms/router.ts`) → `routeByScenario` / `classify`
(`src/llms/tier-router/runtime.ts`) → the pure selector `selectTierRoute`
(`src/llms/tier-router/select.ts`):

1. Strip the subagent tag — first, in every mode, passthrough included — and take the lane from it.
2. A passthrough surface, or a token or surface on the reserved profile: done.
3. Resolve the profile — the authenticating token's `profileKey` wins, else the surface's, else
   `DEFAULT_PROFILE_KEY = 'live'` — and read its routes and every alias in one pass
   (`loadTierProfileView`).
4. Pick the scenario: input tokens over the Long context threshold → `longContext`; else thinking
   on → `think`; else `default`. Thinking is read per surface — Anthropic `thinking` (anything but
   `type: 'disabled'`), OpenAI `reasoning_effort` / `reasoning` (anything but `'none'`), Gemini
   `thinkingConfig` — in `src/llms/router/surface-signals.ts`, `request-signals.ts` and
   `src/llms/utils/gemini/router-signals.ts`.
5. A `think` / `longContext` list with no usable route in the lane (switched on, alias set, target
   on) falls back to the same lane's `default` list. The fallback reads configuration only: a list
   whose routes are all out of quota answers as exhausted rather than borrowing Default's.
6. Walk the list through the gates, skipping a route that fails one:
   1. the route and its target (`Model.enabled && Provider.enabled`) are switched on;
   2. its provider has an alias for the tier it names;
   3. it can run the request's web-search tool, when there is one (`hostsWebSearch` in
      `src/shared/transformer-chain.ts`, decided on the same apiStyle the transformer chain is
      built from);
   4. its `Model.contextWindow` holds the prompt (unknown = allowed);
   5. it is not out of quota — no 429 exhaustion mark, and the scheduler snapshot's reading for
      it is neither spent nor used at or past `quotaSkipPct`;
   6. its 5-minute error rate is under `errorRateSkipPct`, once it has `minHealthSamples` samples.
7. Order the routes that passed by **pace** — the snapshot's `projectedPct`, where the target lands
   at its quota reset if use keeps going: below 60 % moves to the front (quota paid for would go
   unused — Fable, typically), above 100 % to the back (the route the operator listed below it
   takes the traffic before the limit is hit), the rest and targets with no reading keep list
   order. List order holds within each band, and when every route is over pace the first still
   leads: a projection never refuses a request. The first route becomes `body.model`, the rest the
   fallbacks.

`src/api/v1/` does the rest — `buildRoutePlan` runs the router once per request and answers the
429 / 400 below; `buildFailoverChain` orders `[primary, ...fallbacks]` minus exhausted marks;
`attemptChainEntry` walks it, rotating subscription accounts inside one route on 429 before moving
to the next.

**The list's order is followed as written**, pace aside. There is no `auth_mode` gate: a
subscription route keeps the api_key routes after it, and two routes on the same provider are
legitimate because exhaustion is marked per `(provider, model)`. A route the operator did not want
would not be in the list.

**What each outcome answers.** The contract, pinned by `__tests__/llms/route-request.test.ts` and
`__tests__/llms/tier-router/select.test.ts`:

| Situation | `body.model` | Response |
|---|---|---|
| A route passed | the first route after pace ordering; the rest are fallbacks | goes upstream |
| The lane's `default` list (chosen, or fallen back to) has **no routes**, or every route or target on it is switched off | untouched, no fallbacks. **Never a 429**, whatever `exhaustedBehavior` says: an unconfigured list is "no opinion", not "everything is exhausted" | goes upstream as the caller sent it |
| Nothing passed and a route was held by quota or error rate, profile `exhaustedBehavior = '429'` (the default) | untouched | 429 + `Retry-After` (the mark's deadline, else the snapshot's reset, else 30 s) from `buildRoutePlan`, no upstream dispatch |
| Same, `exhaustedBehavior = 'passthrough'` | untouched, no fallbacks | goes upstream as the caller sent it |
| Nothing passed, nothing held by quota or error rate, and a route was skipped for an unset alias, no web search, or a prompt too big | untouched | **400** in the surface's error envelope (`routingRefusal`), whatever `exhaustedBehavior` says — waiting would not change it |
| The profile fails to load (Postgres away), or routing throws | untouched; logged at `error`; fallbacks `[]` | goes upstream as the caller sent it |

`routeRequest` never invents a target: `body.model` is only ever rewritten to a route's resolved
model. A bare model name that reaches the chain walker this way is resolved to the one enabled
provider hosting it (`src/api/v1/invocation.ts`), or refused. `RequestLog.scenario` records the
scenario the request was served under (after any fallback to `default`), or `passthrough` when it
went upstream as sent; Activity labels the column "Scenario". A 429 or 400 from `buildRoutePlan`
dispatches nothing and writes no row.

**The Long context threshold is automatic, then tuned.** The base
(`src/llms/tier-router/threshold.ts`) is 70 % (`LONG_CONTEXT_AUTO_RATIO`) of the context window of
the model the first usable `default` / `agent` route reaches — the rest is room for the reply —
or `DEFAULT_LONG_CONTEXT_THRESHOLD = 128_000` when none resolves to a known window. It follows the
Default alias. On timer ticks (not on a republish), `src/services/routing-scheduler/threshold-tuner.ts`
moves each profile's value at most once a day by 20 %, by the pace of its first usable
`longContext` / `agent` route: below 60 % → lower (more requests reach the model the operator most
wants used), above 100 % → raise, no reading → no change. The value stays within
`[LONG_CONTEXT_FLOOR = 30_000, base]` — never above the base, because a request that big would not
fit the Default model it is being kept on. A lowering is rolled back when that route reads
exhausted within the day; `constraints.autoTuneLongContext = false` stops the tuner (API only, not
on the screen). Every change is logged at `info`.

**Constraints** live in `RouterPreferenceProfile.constraints`: four knobs — `exhaustedBehavior`
(`'429'`), `quotaSkipPct` (100), `errorRateSkipPct` (0.5), `minHealthSamples` (5) — plus the
tuner's state (`longContextThreshold`, null = the base; `previousLongContextThreshold`;
`longContextTunedAt`) and its kill switch `autoTuneLongContext`. `saveTierProfile` keeps the
tuner's three keys from the database whatever the request carries, so an editor's stale copy never
undoes a tune — and there is no manual threshold, not even through the API.
`GET /api/routing/profiles/{key}` returns the value in effect as `longContextThreshold`. A blob
still carrying retired keys (`allowEscalation`, `tierFallback`, …) parses; they are ignored.

**Passthrough** (`routingMode = 'passthrough'`, or a token or surface whose `profileKey` is
the reserved `PASSTHROUGH_PROFILE_KEY = 'passthrough'`). The caller's own `body.model` goes
upstream — `provider,model`, or a bare name hosted by exactly one enabled provider. Classification,
the gates and the persona are skipped; `passthroughDenial` may refuse a `provider,model` the
surface's `deniedTargets` lists. The reserved key is not a stored profile and cannot hold
routes (`saveTierProfile` refuses it).

**Disabled targets are never dispatched, on any path.** `buildLlmsContext` builds the
provider registry and the `providers` view from enabled providers and enabled models only —
the same predicate `/v1/models` advertises (`getEnabledModels`), so the menu and the door
agree. `loadTierProfileView` folds `Model.enabled && Provider.enabled` into each route's
`targetEnabled`, which gate 1 and the Default fallback read and the Routing screen shows apart
from the route's own switch; `resolveInvocationForModel` returns null for a pair outside the
registry; and the per-request subscription account pool (`subscription-account-sync/read.ts`)
filters `Provider.enabled`. A `provider,model` naming a disabled or uncatalogued model is refused,
not forwarded.

**The routing scheduler publishes quota and pace, not weights.** `src/services/routing-scheduler/`
ticks every `ROUTING_SCHEDULER_INTERVAL_MS` (5 minutes) and publishes, for every enabled model of
every enabled subscription provider — whichever profile names it —
`{ exhausted, remainingBudgetPct, projectedPct, resetAt }` plus `soonestResetAt`;
`/api/routing-scheduler-state` serves it as `targets`. `projectedPct` is `projectedUsage` in
`quota-math.ts`: per window, used % ÷ the share of the window elapsed, judged only after 10 % of it
has passed (`PACE_MIN_ELAPSED` — early on, a few requests look like a runaway pace); per account,
the tightest of its binding windows (5h and weekly; Fable reads its own weekly window); across
accounts, weighted by plan capacity (`planCapacityWeight`), because the account picker spreads the
target's traffic over all of them. A target it has never seen (api_key providers, a cold start) is
not held on quota and has no pace. It writes nothing to `RoutingWeightChange` any more, and
Overview's failover feed shows 429s and rejected credentials where the weight moves used to be.
The snapshot, the exhaustion marks and the error-rate ring are process-local.

**Gone:** the requested tier as a routing key — `tierOf(body.model)` and the `other` tier of
v2.89.0; `tierOf` survives only for alias candidates and the chain conversion — and the `image` /
`webSearch` scenarios; `quota-router` and `applyProactiveFailover` (both folded into the selector);
`allowEscalation` / `allowDemotion` / `tierFallback` and the pace-based tier widening;
`/api/router-preferences`, `/api/router-utilization` and `/api/solver-input`; the per-model manual
tier (`manualTier`) on the provider page and in the model PATCH; the scheduler's weights. The token
count goes through `src/llms/tokenizers/` (tiktoken, or model-accurate `@huggingface/tokenizers`),
for the Long context threshold and the context gate. A `tool_result`'s array content is walked
block by block, so an image or document payload nested in a tool result weighs nothing — the same
as a top-level image block; serialising it as text once made one screenshot count as a million
tokens and pushed every later request in that session into `longContext`.

**The chain is converted at seed, by scenario.** v2.89.0 converted only the `default` / `agent`
chain into a map keyed by the tier the caller asked for, and its contract migration (#535) was
reverted (#540), so the old chain is still in the database. Migration
`20260925010000_key_tier_routes_by_scenario` drops the rows keyed by requested tier (a requested
tier is not a scenario), re-keys `TierRoute` by scenario and lane, and clears every profile's
`chainBackfilledAt`. The next `db seed` then runs
`src/services/routing-migration/backfill-tier-routes.ts` for every unmarked profile, `live` first:
every entry of `default` / `think` / `longContext` in both lanes becomes a route in the same list,
in the same order and on/off state, naming its provider and its model's tier, and claims that
provider's alias when the slot is free (an existing alias is never overwritten). `webSearch` /
`image` entries are only counted in the log. Edits made on the v2.89.0 tier-map screen are not
carried over. A profile that fails to convert fails the seed, and `set -e` in `entrypoint.sh` stops
the container rather than start it with that profile silently empty.
`scripts/rebackfill-tier-routes.ts --profile <key>` clears one profile so the next seed converts it
again. `RouterPreferenceEntry`, `RoutingWeightChange`, `ScenarioKey` and `Model.manualTier` stay in
the schema, read only by the backfill (and `manualTier` by the alias candidate list), until a later
contract migration drops them once this build has run in production. Details:
`docs/guides/migration-v3.md`.

**There is no weekly drain guard on the request path.** Subscription providers run to their
upstream limit and are rotated reactively; the quota gate reads the snapshot, and pace only
reorders routes that are still open. `getKindWindowHeadroom` / `drainTarget` still exist in
`src/services/usage-service/`, but nothing on the request path calls them — the only callers left
are tests.

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
were deliberately **not** backfilled into the chain). `POST /api/config` drops the
retired keys with a warning and prunes them from disk on the next save
(`RETIRED_ENVELOPE_KEYS` in `src/services/config/compose.ts`). Routing is one screen.

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
the UI. It sits behind the ordinary `adminAuth` with no exception. `EventSource` cannot
set headers, and it does not need to: neither way into `/api/*` is a header the page
sets — the local exemption reads the `Host` the browser sends anyway, and Cloudflare
Access injects its assertion at the edge. The `?apikey=` query parameter this path used
to accept went with `APIKEY`.

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

- **Disk envelope**: `~/.rialto/config.json`. The whitelist is `ConfigEnvelopeSchema` in `src/schemas/domain/config.ts` — read that, not a list here, because it is what boot actually parses. It carries the boot-time scalars (`HOST` / `PORT` / `LOG` / `LOG_LEVEL` / `LOG_MAX_MB` / `PROXY_URL` / `API_TIMEOUT_MS` / `CLAUDE_PATH` / `NON_INTERACTIVE_MODE`), the archive switches (`CAPTURE_REQUESTS` / `CAPTURE_MESSAGES` / `REDACT_TOOL_ARGUMENTS`), the Cloudflare Access pair (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`), the scheduler tick (`ROUTING_SCHEDULER_INTERVAL_MS`), the active persona's id (`ActivePersona` — also a top-level key on the `/api/config` wire and on the `ConfigStore`), and the disk-resident object `Personas`. Keys the schema does not declare are preserved by its `.catchall`, not dropped — except the retired keys, the routing ones (`Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK`), the removed admin key `APIKEY` and the removed Settings → Status line's `StatusLine`, which `RETIRED_ENVELOPE_KEYS` strips on every read and prunes on the next save.
- **PostgreSQL** (via Prisma, `src/prisma/schema.prisma`): everything else. `DATABASE_URL` is loaded from `.env` (`.devcontainer/compose.yaml` provides `postgres` and `redis`).

The schema is well past the three tables the first PR shipped; the column comments in
`src/prisma/schema.prisma` are the documentation. The rows worth knowing here:

| Table | Notes |
|-------|-------|
| `Provider` | unique `name`, `apiBaseUrl`, `apiKey`, `authMode`, `apiStyle`, `enabled`. **No account is designated** — `activeSubscriptionAccountId` is gone (migration `20260910084500_drop_provider_active_subscription_account`); which SubAccount serves a request is decided per request, and "can this provider authenticate" is asked of its accounts as a set (`src/shared/subscription-credential.ts`). **There is no `transformer` column** — the chain is derived (see Transformer System) and the `transformer._disabledModels` the UI reads is synthesized from `Model.enabled` by `toWireTransformer` |
| `Model` | FK to Provider with `onDelete: Cascade`, composite unique `(providerId, name)`, optional per-model `apiStyle` override. `enabled` is the per-model switch; `Provider.enabled` gates the whole provider above it. `manualTier` is retired — nothing writes it; the backfill and the alias candidate list read it until the contract migration drops it |
| `SubAccount` / `SubAccountUsage` / `SubAccountQuota` | subscription accounts, their observed windows (`SubAccountUsage` for the account picker, `SubAccountQuota` for the scheduler's quota snapshot), and Codex's banked resets (`resetCreditsAvailable`) |
| `RouterPreferenceProfile` | a named profile (`live` is the default): `constraints` (JSONB, no DDL to add a knob) holds the four routing knobs, the Long context tuner's state (`longContextThreshold` / `previousLongContextThreshold` / `longContextTunedAt`, written by the tuner and kept by every save) and its kill switch `autoTuneLongContext`; `chainBackfilledAt` marks the one-shot conversion of its old chain |
| `TierRoute` | the routes: `(profile, scenario, lane, priority) → (provider, targetTier, enabled)`, unique per provider · tier within one list. Keyed by scenario and lane since migration `20260925010000_key_tier_routes_by_scenario`, which dropped the v2.89.0 rows keyed by requested tier. A provider deletion cascades to its routes, and the apply layer counts them first and warns per profile / scenario / lane |
| `ProviderTierAlias` | `(provider, tier) → model`, unique per provider and tier. A model deletion unsets the aliases naming it (cascade, counted and warned about); an unset alias leaves the routes through it skipped. **There is no `RouterSlot` table** (dropped by `20260910095324_drop_router_slot_and_routing_preset`, together with `RoutingPreset`) |
| `RouterPreferenceEntry` / `RoutingWeightChange` | retired: the per-scenario, per-lane chain of concrete models, now read only by the backfill (every lane of it is still there: #540 reverted the contract migration that would have dropped it), and the scheduler's weight log, written by nothing. Both are dropped by a later contract migration |
| `InboundSurfaceConfig` | one row per surface: `routingMode` + `profileKey` + `deniedTargets` |
| `AccessToken` | issued `/v1/*` credentials — sha256 only, optional surface and routing-profile scope |
| `Session` / `Message` / `RequestLog` / `UsageSnapshot` | the archive behind Activity and Overview. `RequestLog.scenario` stores the scenario the request was served under (`default` / `think` / `longContext`) or `passthrough` — older rows hold the requested tier (v2.89.0) or the chain's scenario; `subAccountId` the subscription account that served the request (not a foreign key, like `accessTokenId`), which is what lets `src/services/account-usage-service.ts` price each account's traffic at API rates for Overview and the provider pages; `cacheWrite1hTokens` the 1-hour-TTL share of the cache writes, priced at 2× input against 1.25× for 5 minutes (`src/services/cost-service.ts`) |

Boot sequence — top-level statements in `src/index.ts`, not a `getServer()`:

1. `migrateHomeDir()` — carry a pre-rename `~/.claude-code-router` over to `~/.rialto`. **Must run first**: the migration is idempotent by "the destination already exists", so any earlier `mkdir` of `~/.rialto` makes the copy a permanent no-op. Skipped when `RIALTO_HOME_DIR` pins the home elsewhere.
2. `initDir()` — ensure home directories.
3. `initConfig()` — read the envelope from disk, mirror scalar keys onto `process.env` via `applyEnvelopeToEnv`, then `syncLoggerFromEnv()` re-applies `LOG_LEVEL` and `LOG_MAX_MB` to the already-constructed pino instance.
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

**There is no admin secret.** `APIKEY` — the bootstrap / break-glass key for `/api/*` —
is gone: `ConfigEnvelopeSchema` does not declare it, it is neither mirrored onto nor
overlaid from `process.env`, and quarantining a broken `config.json` salvages only
`Personas`. It was a master key that got past Cloudflare Access for anyone who read it
out of `config.json`, a backup or shell history, and the outages it was kept for
already have a way back in that needs no secret. **Locked out** (Access broken,
`config.json` quarantined, Postgres down): `ssh -L 3456:localhost:3456 <host>` and open
`http://localhost:3456` — a request made on the host is exempt, and that check reads
neither Access nor the database. On Docker, publish the port on the host (loopback is
enough). `curl` run on the host against `http://localhost:3456/api/...` needs no
credential header either.

DDL is not created at boot either: `entrypoint.sh` runs `prisma migrate deploy` and
`prisma db seed` before exec'ing the process.

Config API (`src/api/config/route.ts`, service in `src/services/config/`):

- `GET /api/config` returns `composeUiConfig()` (envelope on disk + DB-resident config).
- `POST /api/config` calls `applyUiConfig(body)`: diffs the incoming UI payload inside a single Prisma transaction and returns `{ success, warnings[] }`. A removed model unsets the tier aliases naming it and a removed provider takes its tier routes with it (both cascade), so the apply layer counts them **before** the delete and warns with which provider tiers or which profile / scenario / lane routes went; the retired keys (`Router` / `CUSTOM_ROUTER_PATH` / `LiveRoutingName` / `CROSS_PROVIDER_FALLBACK` / `APIKEY` / `StatusLine`) are dropped with a warning and never stored. `ActivePersona` is an ordinary top-level key: `''` / `null` clears it, absent leaves it alone. Envelope keys land on disk via `writeConfigFile` after the DB transaction commits, and `applyEnvelopeToEnv` re-mirrors them onto `process.env` — so envelope changes are hot, without a restart.

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
`HOST`** — that check does not exist. What actually gates access: `/api/*` admits
exactly two things — a request made on the host itself (`src/api/local-access.ts`: a
loopback `Host` and no forwarding headers; `RIALTO_TRUST_LOCAL=false` turns it off) and
a verified Cloudflare Access assertion (when `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are
both set). There is no `x-api-key` / `Authorization: Bearer` admin credential. With
`RIALTO_TRUST_LOCAL=false` and Access unconfigured nothing can reach `/api/*`, so boot
logs a warning. `/v1/*` takes **issued `AccessToken`s only**, so an install with no
token issued cannot proxy.

Database tooling (`bun run`, from the repo root — there is no `packages/`):

- `db:generate` — regenerate the Prisma client into `src/generated/prisma/`. Also wired as `postinstall` so a fresh `bun install` materialises it.
- `db:migrate` — create + apply a new migration (development).
- `db:migrate:deploy` — apply existing migrations (production / CI).
- `db:migrate:test` — apply them to `rialto_test`. **Separate database; CI fails without it.**
- `db:reset` — drop and recreate the schema (destructive).
- `db:seed` — `src/prisma/seed.ts`; idempotent, creates the `live` preference profile (no routes until the operator adds them), then converts every unmarked profile's old chain into scenario routes once — `default` / `think` / `longContext` in both lanes (`backfillTierRoutes`, marked on `chainBackfilledAt`, which the `20260925010000` migration cleared on every profile). A conversion failure fails the seed on purpose. No slot rows — there is no such table — and no placeholder Providers.
- `db:seed:demo` — `scripts/seed-demo-data.ts`; dev-only demo data for every screen (traffic, tier aliases and scenario routes, quota, tokens). Rows it owns carry a `demo-` id and `-- --clean` removes them; the demo `cost-first` profile is rewritten on every run; live config (tier aliases, the `live` routes, surface modes, an account's quota) is written only while unset. Never wired into `db:seed`. See `docs/guides/demo-data.md`.
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
(`src/llms/router/request-signals.ts`) returns whether the tag was there and strips it in
place; `routeRequest` calls it **first, in every mode** — routed or passthrough — so the internal
marker never reaches upstream, and records the answer as `RequestLog.isSubagent`. In routed mode
`classify` turns it into the lane, and the selector walks the chosen scenario's `subagent` list
instead of its `agent` one. The model comes from that list, not from the tag body, which is what
makes the lane editable in Routing instead of scattered across prompt files; a tag whose body
names a now-deleted `provider,model` pair still routes correctly — by lane. A subagent Think or
Long context list with nothing usable falls back to the subagent Default list, and an empty
subagent Default passes the caller's own model through: the lane never borrows the agent lane's
routes. (In v2.89.0 the tag selected nothing — the requested-tier map had no lanes. The lane is
back with the scenarios.)

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still accepted (same file,
`SUBAGENT_TAGS`). It lives in prompts users have already written, and dropping it
would send that marker upstream in the caller's system prompt and silently route that traffic on
the agent lane, so it must not be removed.

Only a well-formed (closed) tag is stripped; a malformed one still counts as present
but is left in the prompt. The tag is read from the second block of an Anthropic-shape `system`
array, so requests on the OpenAI and Gemini surfaces — which carry their system prompt in
`messages[0]`, `instructions` or `systemInstruction` — always walk the agent lane.

## Presets

**There is no preset feature.** Three unrelated things used to carry the name, and
all three are gone — do not build on any of them:

1. **`RoutingPreset`** — named snapshots of the retired `Router` slot config. The
   table, `src/services/routing-preset.ts`, `/api/routing-presets`, the built-in tier
   presets (`shared/data/routing-presets.ts`, `lib/routing-map/`) and the Routing
   screen's Presets menu were removed with the slot selector (migration
   `20260910095324_drop_router_slot_and_routing_preset`). The routes are edited in
   place on the Routing screen; there is nothing to snapshot them into.
2. **`src/lib/presets/`** — the dynamic-input form (`form-logic.ts`, `types.ts`)
   behind a Settings → Presets screen. Both went with that screen; there is no
   `/settings/presets` route in `src/app/routes.tsx`.
3. **The preset manifest schemas** that used to fill `src/schemas/domain/preset.ts` —
   `PresetFileSchema`, `PresetMetadataSchema`, `ConditionSchema` and the rest,
   inherited from the deleted CLI preset installer. Deleted; nothing ever parsed a
   manifest, so the `rialtoVersion` / `ccrVersion` compatibility they carried is moot.

What survives at that path is only the recursive JSON value schema —
`JsonPrimitiveSchema` / `JsonValueSchema` / `JsonObjectSchema` — which backs the
`.catchall` on `schemas/api/config.ts` and `schemas/domain/config.ts`. The file name is
historical. `__tests__/preset/schema.test.ts`
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

**Refreshing the catalog** is half of the one "Refresh" button beside the add button on
every Providers screen — both lists and both kinds of provider page. That half is
`POST /api/catalog/refresh` followed by `POST /api/refresh-models`; the two used to be
separate "Refresh prices" and "Sync models" buttons, but the second is what makes the
first show. It ends in `refreshModelsForAllProviders`, and what that can recover comes
from three sources that must not be conflated:

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
scrape degrades coverage rather than nulling existing rows. The same holds for routing:
a refresh that finds a new model never moves a tier alias. It creates the row (switched
off on a subscription provider unless the preset lists it) and `GET /api/tier-aliases`
offers it as a candidate for its tier; promoting it is an edit on the provider's page. The
one thing a refresh does set is a still-unset tier on a Claude subscription provider: like
adding the provider, it points that tier at the preset's model for it
(`ensurePresetAliases`), which is how a new Claude subscription routes without anyone
setting its aliases.

**Refreshing subscriptions** is the other half of the same button, on the screens that
show subscription accounts — the Subscriptions list and a subscription provider's page
(`POST /api/subscriptions/refresh`, `src/services/subscription-refresh-service.ts`). The
UI runs the two halves side by side with `Promise.allSettled`, so one failing does not
cost the other its answer. It is not a catalog operation and touches no model or price.
It re-syncs accounts the way `POST /api/subscriptions/sync` does, then polls usage with
`forceRefresh` past the 5-minute cache in `src/services/usage-service/cache.ts`, and
rewrites the two current-state tables — `SubAccountUsage` (the account picker) and
`SubAccountQuota` (the routing scheduler, and the list's quota column via
`/api/overview`). Its scope is the optional body: none (or `{}`) covers every account on
an **enabled** subscription provider, which is the list; `{ provider }` covers that
provider's accounts **even while it is switched off**, which is its page — whether a
switched-off provider's credentials still work is what an operator asks before switching
it back on — and a name no subscription provider has is a 404. It deliberately writes no
`UsageSnapshot` row, so the Usage chart stays on the usage job's 5-minute grid; leaves an
account's rows alone when its upstream call failed and names it in `failed[]` instead;
and coalesces concurrent calls for the same scope into one upstream pass — there is no
cooldown beyond that. **Routing reads the result at once**, before the call returns: the
in-process exhaustion marks the fresh reading contradicts are lifted — an account mark
when none of the account's account-wide windows is at its limit, a model mark when some
freshly read account on the provider can serve that model, per-model windows (Fable's
weekly) included; provider marks (`insufficient_quota`, an api_key spend cap) are left to
expire — and `republishRoutingSnapshot()` publishes a quota snapshot computed after the
write instead of waiting for the next scheduler tick. Otherwise an account reset from the
vendor's own app stayed behind its peers until its original reset time, days away on a
weekly window. Connecting an account and spending a banked Codex reset
(`POST /api/subscriptions/accounts/{id}/reset-usage`; `GET …/reset-credits` lists them,
and nothing spends one automatically) go through the same path. `/sync` is unchanged: it
still probes every provider, disabled ones included, because that is what the auth-health
job runs.


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
   `bun install` needs `GH_TOKEN` (a token with `read:packages`): the
   `@qtmleap` scope comes from GitHub Packages (`bunfig.toml`). `.envrc` and the
   devcontainer's `postCreateCommand.sh` fill it from `gh auth token`; CI, the
   weekly update job and Dependabot read the repository secret of that name, and
   the Docker build takes it as the `gh_token` build secret.
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

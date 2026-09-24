# Routing: the tier map

## Purpose

A reference for how a routed request picks its upstream: what is stored, what one request walks,
which gates can skip a route, and what the four outcomes answer. The request path around it —
the failover walker, account rotation, the pipeline — is in [request-flow.md](./request-flow.md)
and [pipeline-overview.md](./pipeline-overview.md). The plan this implements, with the reasons
for each decision, is [quota-and-tier-routing.md](../plan/quota-and-tier-routing.md) (Japanese).

**Routing names a provider and a tier, never a model.** The map it replaced — an ordered chain of
concrete models per scenario (`default` / `think` / `longContext` / `webSearch` / `image`) and per
lane (`agent` / `subagent`) — had to be re-wired every time a vendor shipped a model, because every
entry pointed straight at a `Model` row. Now the model a tier means is one alias per provider, so a
new Sonnet moves one pointer and every route that says "that provider's sonnet" follows it.

## Two modes

Every inbound surface stores one `routingMode` (`InboundSurfaceConfig`, seeded `passthrough` —
see [inbound-surfaces.md](./inbound-surfaces.md)).

| Mode | What happens | Chosen by |
|---|---|---|
| `routed` | The request's tier is looked up in a profile's tier map and `body.model` is rewritten to the first route that can serve it | The surface's `routingMode` |
| `passthrough` | The caller's own `body.model` goes upstream — `provider,model`, or a bare name hosted by exactly one enabled provider. The map, the gates and the persona are skipped; `passthroughDenial` may refuse a target the surface's `deniedTargets` lists | The surface's `routingMode`, or the reserved profile key `passthrough` on the authenticating `AccessToken` (or on the surface) |

In both modes the subagent tag is stripped first and recorded as `RequestLog.isSubagent` (see
[The subagent tag](#the-subagent-tag)).

## Data model

| Table | Key | What it says |
|---|---|---|
| `RouterPreferenceProfile` | `key` (`live` is the default) | A named profile. `constraints` (JSONB) holds the four knobs below; `chainBackfilledAt` marks the one-shot conversion of its old chain |
| `TierRoute` | `(profileId, requestedTier, priority)` | "A request for `requestedTier` may be served by `provider`'s `targetTier`", in `priority` order (1 first). `enabled` is a soft toggle that keeps the route's place |
| `ProviderTierAlias` | `(providerId, tier)` | "`tier` on this provider is `model`." The one pointer a model release moves |
| `InboundSurfaceConfig.profileKey` / `AccessToken.profileKey` | — | Which profile a surface, or one client, routes through |

- **Requested tiers** are `fable` / `opus` / `sonnet` / `haiku` / `other`; **target tiers** are the
  first four. `other` is any model name that says no Claude family (`gpt-*`, `gemini-*`, a custom
  id). Tiers are strings validated by Zod (`src/schemas/domain/tier-route.ts`), not Prisma enums,
  for the same reason as `routingMode`: a new family is a code change, not a migration.
- **Substitution is a route, written down.** `haiku → [claude-code · sonnet]` sends Haiku requests
  to that provider's Sonnet. The chain's tier gate (`allowEscalation` / `allowDemotion`, and the
  `tierFallback` retry that papered over it) is gone: a substitution hidden in a gate could refuse
  a request nobody could see a reason for.
- **Cascades.** Deleting a model unsets the aliases that named it; deleting a provider removes its
  aliases and every route that named it. The apply layer counts both before the delete and returns
  a warning (`src/services/config/apply/tier-route-cascade.ts`).

## One request

`routeRequest` (`src/llms/router.ts`) → `routeByTier`
(`src/llms/tier-router/runtime.ts`) → `selectTierRoute` (`src/llms/tier-router/select.ts`, pure).

1. **Strip the subagent tag** and remember whether it was there — in every mode.
2. **Mode.** Passthrough stamps `route = 'passthrough'` and returns: `body.model` is untouched,
   there are no fallbacks, and no persona is added.
3. **Signals.** `signalsOf` reads the request in its own wire vocabulary
   (`src/llms/router/surface-signals.ts`); routing uses two of them — what to hand the
   tokenizer, and whether the request carries a web-search tool. The token count comes from
   `src/llms/tokenizers/`.
4. **Profile.** The token's `profileKey` wins, else the surface's, else `live`.
5. **Load.** `loadTierProfileView` reads the profile's routes and every alias in one pass and
   resolves each route to its model, whether that model and its provider are both switched on,
   whether it can run web search, and its `Model.contextWindow`.
6. **Requested tier.** `tierOf(body.model)` — a case-insensitive substring match on `fable`, `opus`,
   `sonnet`, `haiku`, in that order — else `other`.
7. **Select.** The tier's routes are walked in order through the gates below. Every route that
   passes is kept: the first becomes `body.model`, the rest become the fallbacks the reactive
   failover path walks (`buildFailoverChain` in `src/api/v1/candidate-chain.ts`).
8. **Persona.** On `/v1/messages` only, the active persona is appended on every routed exit —
   a route found, no route taken, or routing failed — because it is a property of the install, not
   of whether a route was found. OpenAI-shape and Gemini callers get exactly what they sent.

`routeRequest` never throws and never invents a target: `body.model` is only ever rewritten to a
route's resolved model. If the map cannot be read (Postgres away) or routing throws (the tokenizer
is a native module), the caller's model goes out untouched, logged at `error`.

### Gates, in order

| # | Gate | Skip reason | Reads | Why it is here |
|---|---|---|---|---|
| 1 | The route and its target are switched on | `disabled` | `TierRoute.enabled`, `Model.enabled && Provider.enabled` | A switched-off target is never dispatched on any path; the registry the walker resolves against holds enabled models only |
| 2 | The provider has an alias for the route's tier | `alias_unset` | `ProviderTierAlias` | A route to "that provider's opus" means nothing until someone says which model that is |
| 3 | It can run the request's web-search tool | `no_web_search` | `hostsWebSearch` (`src/shared/transformer-chain.ts`) | Anthropic sends `web_search` as-is, Responses maps it to the hosted tool, Gemini to `googleSearch`; Chat Completions has no equivalent. Decided on the same apiStyle the transformer chain is built from, so the Routing screen's badge and the skip cannot drift from what runs |
| 4 | Its context window holds the prompt | `context_too_small` | `Model.contextWindow` vs the token count | A prompt too big for one route goes to the next that can hold it, instead of to an upstream that would refuse it. An unknown window is trusted |
| 5 | It is not out of quota | `exhausted` | Exhaustion marks (`failover-state`) and the scheduler snapshot's `targets` | See [The quota snapshot](#the-quota-snapshot). A target the snapshot has never seen (api_key providers, a cold start) is not held on quota |
| 6 | Its recent error rate is under the threshold | `error_rate` | `model-health` (5-minute in-process ring per target) | Only once the target has `minHealthSamples` samples: one failure out of one is not a rate |

The ring behind gate 6 is fed by the chain walker: a success, and a 429 that could not be rotated
away to a peer account. Other upstream errors are relayed verbatim and not counted.

### Outcomes

| Outcome | When | `body.model` | Answer | `RequestLog.scenario` |
|---|---|---|---|---|
| **routed** | At least one route passed | The first passing route's model; the rest are fallbacks | Dispatched | The requested tier |
| **passthrough** | The tier has no routes, or every route or target is switched off | Untouched, no fallbacks | Dispatched as the caller sent it — an unconfigured tier is "no opinion", **never** a 429 | `passthrough` |
| **exhausted** | Nothing passed and at least one route was held by quota (5) or health (6) | Untouched | `exhaustedBehavior = '429'` (default): `buildRoutePlan` answers 429 + `Retry-After` in the surface's error envelope without dispatching. `'passthrough'`: dispatched as sent | `'429'`: the requested tier; `'passthrough'`: `passthrough` |
| **refused** | Nothing passed and nothing was held by quota or health, but some route was skipped by 2–4 (alias unset, no web search, prompt too big) | Untouched | 400 in the surface's envelope (`invalid_request_error`, `INVALID_ARGUMENT` on Gemini), with the reasons. `exhaustedBehavior` does not soften it: waiting would not change the answer | The requested tier |

`Retry-After` is the soonest moment one of the routes held on quota can serve again: its
exhaustion mark's deadline when a 429 set one, else the snapshot's `resetAt` for it, else 30 s.
Answers 429 and 400 come from `src/api/v1/route-plan.ts`, because `routeRequest` swallows every
exception and a refusal raised inside it would never reach the client.

`RequestLog.scenario` keeps its column name, with no `@map`; rows written before the tier map
hold the scenario the retired classifier chose. Activity labels the column "Route".

### The subagent tag

`<RIALTO-SUBAGENT-MODEL>…</RIALTO-SUBAGENT-MODEL>` (or the pre-rename `<CCR-SUBAGENT-MODEL>`) at the
start of the second system block is stripped before anything else, in every mode, and its presence
is recorded as `isSubagent`. **It selects nothing** — there are no lanes. A subagent's request is
routed by the tier its own model name asks for, like any other. The tag is still removed because it
is a Rialto marker no upstream should see, and still recorded so Activity can tell the two kinds of
traffic apart.

## Constraints

Four knobs, stored in `RouterPreferenceProfile.constraints` and defaulted by
`RoutingConstraintsSchema`:

| Knob | Default | Meaning |
|---|---|---|
| `exhaustedBehavior` | `'429'` | What an exhausted tier answers: 429 + `Retry-After`, or the caller's own model upstream |
| `quotaSkipPct` | `100` | Skip a route whose snapshot budget is used at or past this percentage |
| `errorRateSkipPct` | `0.5` | Skip a route whose 5-minute error rate is at or above this (0–1)… |
| `minHealthSamples` | `5` | …once it has at least this many samples |

A blob that still carries retired keys (`longContextThreshold`, `allowEscalation`,
`tierFallback`, the scheduler's scoring knobs) parses; they are ignored, and a save merges the four
knobs over the blob rather than replacing it. A blob that does not parse reads as the defaults.

## The quota snapshot

The routing scheduler (`src/services/routing-scheduler/`) publishes one reading per target —
**every enabled model of every enabled subscription provider**, not only those a profile names —
so every profile's routes are gated on quota:

| Field | Meaning |
|---|---|
| `targets[].exhausted` | Every account behind the target reads as spent now. Only a fresh, known reading counts: an account never polled, or one gone stale, leaves the target open and the upstream's own 429 is the judge |
| `targets[].remainingBudgetPct` | Capacity-weighted remaining budget across the target's accounts, 0–100 (null with no fresh reading). An account's budget is its tighter of 5h / weekly; a Fable target reads the Fable-scoped weekly window |
| `targets[].resetAt` | When the budget next refills |
| `soonestResetAt` | The earliest reset across the exhausted targets |

A spent account-wide window (5h or 7d; Codex primary / secondary) refuses every request on the
account, so the scheduler holds the account's other windows as spent too, until the last spent
account-wide window resets (`account-limit.ts`). Only in its own view: what is stored and shown is
the vendor's reading.

**When it is published.** A tick every `ROUTING_SCHEDULER_INTERVAL_MS` (default 5 minutes,
minimum 60 s; the first one an interval after boot), plus `republishRoutingSnapshot()` whenever
fresh quota has been written — the Providers screens' Refresh, a newly connected account, a spent
Codex reset. Two ticks never overlap: a republish queues behind a running tick, because the running
one read `SubAccountQuota` before the write. A failed tick keeps the previous snapshot.
`GET /api/routing-scheduler-state` serves it.

**No weights.** The scheduler used to compute a weight per chain entry; the request path only ever
asked whether a weight was zero, and a damper made that answer lag the budget by up to five ticks.
It now publishes the quota reading itself, and writes nothing to `RoutingWeightChange`.

### Exhaustion marks

The reactive 429 path (`src/api/v1/chain-failover.ts`) writes in-process marks that gate 5 reads:

| Mark | Written when | Lifted when |
|---|---|---|
| Account | A subscription account 429s; until the binding window's reset, else 5 minutes | It expires; a request on that account succeeds; a Refresh reads the account below its limits |
| Model `(provider, model)` | No peer account is left to rotate to | It expires (5 minutes); a Refresh finds a freshly read account on the provider that can serve that model, per-model windows included |
| Provider | `insufficient_quota` (an api_key spend cap) | It expires (5 minutes). Refresh never lifts it: no subscription reading speaks for an api_key cap |

Marks are process-local, as are the snapshot and the health ring; several instances do not share
them. The lifting on Refresh is `releaseRecoveredMarks` in
`src/services/subscription-refresh-service.ts`: a reset spent in the vendor's own app used to leave
the account behind its peers until the original reset time, days away on a weekly window.

## Aliases and model releases

`ProviderTierAlias` is edited on the provider's page, where the model table and the Refresh that
discovers new models already are; it is also a property of the provider across every profile.

- **Presets alias themselves.** When a Claude subscription provider's models are created — on adding
  the provider (same transaction) and on a catalog refresh — `ensurePresetAliases` points each unset
  tier at the first model of the preset's `defaultEnabledModels` whose name says that tier. Codex
  names no Claude family, so its aliases are the operator's to set. An existing alias is never
  touched.
- **A release is never promoted automatically.** A catalog refresh adds the new model — switched off
  on a subscription provider unless the preset lists it, on for api_key providers unless deprecated or
  legacy — and `GET /api/tier-aliases` lists it as a candidate for the tier its name says, flagged
  `isNew` when it appeared after the alias was last set. Pointing the alias at it is the operator's
  call, because a new model's price, entitlement and behaviour are what someone should look at
  before every Sonnet request lands on it.
- **Promoting** is choosing the model in the alias picker and saving the page:
  `PUT /api/providers/{name}/tier-aliases/{tier}` sets the alias and switches the model on in one
  transaction; when that switch flipped, it also mirrors `Providers` to disk and drops the cached
  LLM context, so the next request rebuilds the provider registry and already reaches the model.
  The picker offers every model of the provider, not only the name-matched candidates — otherwise
  a Codex or OpenAI model could never be aliased.
- **Unsetting** (`DELETE …/tier-aliases/{tier}`) leaves routes naming that tier skipped as
  `alias_unset` until one is set again; a tier whose switched-on routes all lack an alias answers
  400.

## Editing and reading

| Endpoint | What it does |
|---|---|
| `GET /api/routing/profiles` | Every profile a surface or token can point at — `live` even before it has a row — plus the reserved `passthrough`, flagged as such |
| `GET /api/routing/profiles/{key}` | The profile's routes per requested tier, each resolved through its alias (`model`, `targetEnabled`, `hostsWebSearch`, `contextWindow`, or `null` when unset), and its constraints |
| `PUT /api/routing/profiles/{key}` | Whole-profile replacement in one transaction. An unknown provider is dropped and a duplicate provider·tier keeps its first place, both with a warning; an unset alias is kept and warned about. `passthrough` is refused (400) |
| `GET /api/tier-aliases` | Every provider's four tier slots, set or not, with candidates |
| `PUT` / `DELETE /api/providers/{name}/tier-aliases/{tier}` | Set (promote) / unset one alias |
| `GET /api/routing-scheduler-state` | The quota snapshot |

The Routing screen picks a surface, then its mode and profile, then shows the profile's map as
one table grouped by requested tier, each row with its resolved model and state (ok / N% used / exhausted
until the reset / alias unset / target off), and the four constraints below it.

`/api/router-preferences`, `/api/router-utilization` and `/api/solver-input` are gone, and so is the
per-model manual tier (`manualTier`) on the provider page and in the model PATCH.

## From the chain to the tier map

`db seed` converts each profile's old chain once (`src/services/routing-migration/`);
[migration-v3.md](../guides/migration-v3.md) has the operator-facing version.

- **When.** `entrypoint.sh` runs `prisma db seed` after `migrate deploy` on every start;
  `RouterPreferenceProfile.chainBackfilledAt` makes it once per profile, and a profile that already
  has tier routes is only marked. `live` goes first so the default profile claims the aliases.
- **Failure stops the container.** Each profile converts in its own transaction, but the error is not
  swallowed: carrying on would start the new build with that profile silently empty, every request
  on it passed through.
- **What it reads:** the `default` / `agent` chain, for every requested tier. The classifier sent a
  request to the other scenarios by size, thinking or effort, not by the tier it asked for, so no tier
  row can reproduce them; their entries, and the subagent lanes', are counted in the notes.
- **What it reproduces,** per requested tier: the chain's order; an entry the profile's
  `allowEscalation` / `allowDemotion` would have refused, as a route switched off; when that leaves
  the tier nothing that can serve, the refused routes switched back on, nearest tier first and the
  cheaper side on a tie, as the interim nearest-tier fallback did — unless the profile set
  `tierFallback: 'refuse'`; and every entry for `other`, which the gate never applied to. Aliases
  are claimed from the chain — an entry of the tier being converted first, routable before
  switched off, then priority — and an existing alias is never overwritten.
- **What it does not:** pace widening, and two models of the same provider and tier, which collapse
  into one route to that provider's alias. Every such difference is a note in the seed log.
- **Re-running** one profile: `bun run scripts/rebackfill-tier-routes.ts --profile <key>` deletes its
  tier routes and clears its mark, and the next `bun run db:seed` converts the chain again. Aliases
  are left as they are. It exists for a rollback: while the previous image runs, Routing edits land
  only in the old chain.

A later release's contract migration (P2-7 in the plan) drops `RouterPreferenceEntry`,
`RoutingWeightChange`, the `ScenarioKey` / `RouterPreferenceKind` enums, `Model.manualTier` and
`chainBackfilledAt`, together with the backfill and its re-run script. Until then the backfill and
the alias candidate list still read `Model.manualTier`.

## Tests

| Test | What it pins |
|---|---|
| `__tests__/llms/tier-router/select.test.ts` | The gates, their order, and the four outcomes |
| `__tests__/llms/route-request.test.ts` | `routeRequest` end to end with seeded maps: the outcome contract, profiles, marks, the snapshot, the subagent tag, the persona |
| `__tests__/api/route-plan.test.ts` | 429 + `Retry-After` and the refusal 400 in each surface's envelope |
| `__tests__/services/plan-tier-routes.test.ts` / `__tests__/db/backfill-tier-routes.test.ts` | The backfill planner, and its idempotence against the database |
| `__tests__/db/tier-route-service.test.ts` / `__tests__/db/tier-alias-service.test.ts` / `__tests__/api/routing-profiles.test.ts` | Storage, candidates, promotion and the API |
| `__tests__/services/routing-scheduler/{targets,tick-targets,tick-concurrency}.test.ts` | The per-target reading, which targets are published, and that ticks never overlap |

The full list is in [testing-map.md](./testing-map.md).

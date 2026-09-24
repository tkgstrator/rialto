# Routing: scenarios and provider tiers

## Purpose

A reference for how a routed request picks its upstream: what is stored, how one request is
classified, which gates can skip a route, how pace reorders the routes that pass, and what the
four outcomes answer. The request path around it — the failover walker, account rotation, the
pipeline — is in [request-flow.md](./request-flow.md) and
[pipeline-overview.md](./pipeline-overview.md). The design this implements, with the reason for
each decision, is [scenario-tier-routing.md](../plan/scenario-tier-routing.md) (Japanese).

**Routing is by scenario and lane; a route names a provider and a tier, never a model.** A
request is classified into a scenario (`default` / `think` / `longContext`) and a lane (`agent` /
`subagent`), and that list says which provider tiers may serve it, top first. The model a tier
means is one alias per provider, so a new Sonnet moves one pointer and every route that says
"that provider's sonnet" follows it.

How it got here, because each step explains a piece of the current shape:

| Build | What routing was keyed by | Why it changed |
|---|---|---|
| Before v2.89.0 | Scenario × lane, each list an ordered chain of concrete models (`RouterPreferenceEntry`) | Every entry pointed at a `Model` row, so every vendor release meant re-wiring every list that should use it |
| v2.89.0 | The tier the caller's model name asked for (`fable` / `opus` / `sonnet` / `haiku` / `other`) → provider · tier ([quota-and-tier-routing.md](../plan/quota-and-tier-routing.md)) | The operator had asked for provider · tier *in place of the model*, not for a new key. Converting to a requested-tier key dropped every `think` / `longContext` / subagent list, and Opus requests started landing on Sonnet |
| Now | Scenario × lane again, each list an ordered set of provider · tier routes | Keeps the scenarios the operator configured and changes only what a row holds |

## Two modes

Every inbound surface stores one `routingMode` (`InboundSurfaceConfig`, seeded `passthrough` —
see [inbound-surfaces.md](./inbound-surfaces.md)).

| Mode | What happens | Chosen by |
|---|---|---|
| `routed` | The request is classified into a scenario and a lane, and `body.model` is rewritten to the first route of that list that can serve it | The surface's `routingMode` |
| `passthrough` | The caller's own `body.model` goes upstream — `provider,model`, or a bare name hosted by exactly one enabled provider. Classification, the gates and the persona are skipped; `passthroughDenial` may refuse a target the surface's `deniedTargets` lists | The surface's `routingMode`, or the reserved profile key `passthrough` on the authenticating `AccessToken` (or on the surface) |

In both modes the subagent tag is stripped first and recorded as `RequestLog.isSubagent` (see
[The subagent tag](#the-subagent-tag)).

## Data model

| Table | Key | What it says |
|---|---|---|
| `RouterPreferenceProfile` | `key` (`live` is the default) | A named profile. `constraints` (JSONB) holds the knobs and the Long context tuner's state below; `chainBackfilledAt` marks the one-shot conversion of its old chain |
| `TierRoute` | `(profileId, scenario, lane, priority)` | "A request classified into `scenario` on `lane` may be served by `provider`'s `targetTier`", in `priority` order (1 first). `enabled` is a soft toggle that keeps the route's place. A provider's tier appears at most once per list (`@@unique([profileId, scenario, lane, providerId, targetTier])`): a second copy would resolve to the same model and could only ever be skipped |
| `ProviderTierAlias` | `(providerId, tier)` | "`tier` on this provider is `model`." The one pointer a model release moves |
| `InboundSurfaceConfig.profileKey` / `AccessToken.profileKey` | — | Which profile a surface, or one client, routes through |

- **Scenarios** are `default` / `think` / `longContext`; **lanes** are `agent` / `subagent`;
  **tiers** are `fable` / `opus` / `sonnet` / `haiku`. All are strings validated by Zod
  (`src/schemas/domain/tier-route.ts`), not Prisma enums, for the same reason as `routingMode`: a
  new one is a code change, not a migration. Rows another build wrote are not handed to a reader
  that switches on them: an unknown scenario or lane is dropped on read, and a tier that does not
  parse makes the whole profile read as empty, logged at `warn`.
- **`image` and `webSearch` are no longer scenarios.** Every model worth routing to reads images,
  and a request carrying a web-search tool is served by the routes that can run it — a gate, not
  a list of its own (gate 3 below).
- **The model name the caller sent picks nothing.** The list says which provider tiers serve the
  scenario; `body.model` is only what goes out when nothing is routed.
- **Cascades.** Deleting a model unsets the aliases that named it; deleting a provider removes its
  aliases and every route that named it. The apply layer counts both before the delete and returns
  a warning naming the provider tiers, or the `profile/scenario/lane` lists, that lost something
  (`src/services/config/apply/tier-route-cascade.ts`).

## One request

`routeRequest` (`src/llms/router.ts`) → `routeByScenario`, which calls `classify`
(`src/llms/tier-router/runtime.ts`) → `selectTierRoute` (`src/llms/tier-router/select.ts`, pure).

1. **Strip the subagent tag** and take the lane from it — `subagent` when it was there, `agent`
   otherwise — in every mode.
2. **Mode.** Passthrough stamps `route = 'passthrough'` and returns: `body.model` is untouched,
   there are no fallbacks, and no persona is added.
3. **Signals.** `signalsOf` reads the request in its own wire vocabulary
   (`src/llms/router/surface-signals.ts`): what to hand the tokenizer, whether thinking is on,
   and whether the request carries a web-search tool. The token count comes from
   `src/llms/tokenizers/`.
4. **Profile.** The token's `profileKey` wins, else the surface's, else `live`.
5. **Load.** `loadTierProfileView` reads the profile's routes and every alias in one pass and
   resolves each route to its model, whether that model and its provider are both switched on,
   whether it can run web search, and its `Model.contextWindow`. It also computes the Long context
   threshold in effect.
6. **Scenario.** Input tokens over the [Long context threshold](#the-long-context-threshold) →
   `longContext`; otherwise thinking on → `think`; otherwise `default`. Long input wins because a
   long prompt is Long context whether or not it asks to think.
7. **Fall back to Default.** When the chosen `think` or `longContext` list has no usable route in
   the lane — none that is switched on, has its alias set and reaches a model that is on — the
   request is classified `default` in the same lane instead. An unconfigured list is "no opinion",
   so the lane's everyday list serves it. The fallback reads configuration only: a Think list whose
   routes are all out of quota answers as exhausted (below); it does not borrow Default's routes.
8. **Select.** The list's routes are walked in order through the [gates](#gates-in-order); the
   ones that pass are ordered by [pace](#pace). The first becomes `body.model`, the rest become the
   fallbacks the reactive failover path walks (`buildFailoverChain` in
   `src/api/v1/candidate-chain.ts`).
9. **Persona.** On `/v1/messages` only, the active persona is appended on every routed exit —
   a route found, no route taken, or routing failed — because it is a property of the install, not
   of whether a route was found. OpenAI-shape and Gemini callers get exactly what they sent.

`routeRequest` never throws and never invents a target: `body.model` is only ever rewritten to a
route's resolved model. If the profile cannot be read (Postgres away) or routing throws (the
tokenizer is a native module), the caller's model goes out untouched, logged at `error`.

### Reading thinking

`think` grades what the client asked for, so thinking is read off the request's own opt-in, per
surface. Absence is never an opt-in, even though some vendors reason by default.

| Surface | Thinking is on when | Reader |
|---|---|---|
| `/v1/messages` | `thinking` is an object whose `type` is anything but `'disabled'` — `enabled` and `adaptive` both count | `isThinkingEnabled` (`src/llms/router/request-signals.ts`) |
| `/v1/chat/completions`, `/v1/responses` | `reasoning_effort` or `reasoning.effort` is set to anything but `'none'`, or `reasoning` is an object with no effort at all (Codex CLI sends `reasoning: {summary: 'auto'}`, and asking for a summary of the reasoning is asking for reasoning). Both spellings are read on both surfaces, since clients send whichever their SDK emits | `openAiReasoningRequested` (`src/llms/router/surface-signals.ts`) |
| `/v1beta/models/*` | `generationConfig.thinkingConfig` (or `generation_config`) asks for thinking — a `thinkingLevel` or `thinkingBudget` that does not map to `none`, or `includeThoughts` — read through the same `inboundReasoning` the request conversion uses. A `thinkingLevel` it does not recognise counts: `none` is recognised, so an unknown level can only ask to think | `readGeminiSignals` (`src/llms/utils/gemini/router-signals.ts`) |

### Gates, in order

| # | Gate | Skip reason | Reads | Why it is here |
|---|---|---|---|---|
| 1 | The route and its target are switched on | `disabled` | `TierRoute.enabled`, `Model.enabled && Provider.enabled` | A switched-off target is never dispatched on any path; the registry the walker resolves against holds enabled models only |
| 2 | The provider has an alias for the route's tier | `alias_unset` | `ProviderTierAlias` | A route to "that provider's opus" means nothing until someone says which model that is |
| 3 | It can run the request's web-search tool | `no_web_search` | `hostsWebSearch` (`src/shared/transformer-chain.ts`) | Anthropic sends `web_search` as-is, Responses maps it to the hosted tool, Gemini to `googleSearch`; Chat Completions has no equivalent. Decided on the same apiStyle the transformer chain is built from, so the skip cannot drift from what runs. This is what replaced the `webSearch` scenario |
| 4 | Its context window holds the prompt | `context_too_small` | `Model.contextWindow` vs the token count | A prompt too big for one route goes to the next that can hold it, instead of to an upstream that would refuse it. An unknown window is trusted |
| 5 | It is not out of quota | `exhausted` | Exhaustion marks (`failover-state`) and the scheduler snapshot's `targets` | Held when a 429 marked the model or its provider, or the snapshot reads it spent, or used at or past `quotaSkipPct`. A target the snapshot has never seen (api_key providers, a cold start) is not held on quota. See [The quota snapshot](#the-quota-snapshot) |
| 6 | Its recent error rate is under the threshold | `error_rate` | `model-health` (5-minute in-process ring per target) | Only once the target has `minHealthSamples` samples: one failure out of one is not a rate |

The ring behind gate 6 is fed by the chain walker: a success, and a 429 that could not be rotated
away to a peer account. Other upstream errors are relayed verbatim and not counted.

### Pace

The routes that pass every gate are reordered by **pace**: the snapshot's `projectedPct` for each
target — where its quota lands at the reset if use keeps going as it has, 100 meaning exactly
spent.

| Band | `projectedPct` | Where the route goes | Why |
|---|---|---|---|
| Surplus | below 60 (`PACE_SURPLUS_PCT`) | To the front | Quota the operator pays for would be left unused at the reset — Fable, on most installs |
| Even | 60–100, or no reading | Stays in list order | On track, or nothing to judge by: the operator's order stands |
| Over | above 100 (`PACE_OVER_PCT`) | To the back | On track to run out before the reset, so the route the operator listed below it — typically a lower tier — takes the traffic before the limit is hit |

List order holds within each band (the sort is stable), so pace only moves a route across bands,
never reshuffles a band. When every route is over pace, the first still leads: a projection alone
never refuses a request — that is the quota gate's job, on readings, not forecasts. A reorder is
logged at `info` (`[routing] pace reordered the list`, with the routes promoted and stepped down).

Pace orders only what passed: a route held by gate 5 is not in the list to reorder. `quotaSkipPct`
and pace are therefore independent: `quotaSkipPct` holds a route on how much is used, pace moves
the ones still open by how fast it is going.

### Outcomes

| Outcome | When | `body.model` | Answer | Route stamped (`RequestLog.scenario`) |
|---|---|---|---|---|
| **routed** | At least one route passed | The first route after pace ordering; the rest are fallbacks | Dispatched | The scenario — after the fallback to Default, so a Think request served by Default's list is recorded `default` |
| **passthrough** | The lane's Default list (the chosen list, or the one it fell back to) has no routes, or every route or target on it is switched off | Untouched, no fallbacks | Dispatched as the caller sent it — an unconfigured list is "no opinion", **never** a 429 | `passthrough` |
| **exhausted** | Nothing passed and at least one route was held by quota (5) or health (6) | Untouched | `exhaustedBehavior = '429'` (default): `buildRoutePlan` answers 429 + `Retry-After` in the surface's error envelope without dispatching. `'passthrough'`: dispatched as sent | `'429'`: nothing is dispatched, so no row is written. `'passthrough'`: `passthrough` |
| **refused** | Nothing passed and nothing was held by quota or health, but some route was skipped by 2–4 (alias unset, no web search, prompt too big) | Untouched | 400 in the surface's envelope (`invalid_request_error`, `INVALID_ARGUMENT` on Gemini), with the reasons. `exhaustedBehavior` does not soften it: waiting would not change the answer | Nothing is dispatched, so no row is written |

When skip reasons mix, exhausted wins over refused and refused over passthrough: one route held on
quota means waiting might help.

A Think or Long context list whose routes all lack an alias never reaches "refused": it is not
usable, so the request has already fallen back to Default (step 7). A Default list in that state
has nowhere to fall back to, and answers 400.

`Retry-After` is the soonest moment one of the routes held on quota can serve again: its
exhaustion mark's deadline when a 429 set one, else the snapshot's `resetAt` for it, else 30 s.
Answers 429 and 400 come from `src/api/v1/route-plan.ts`, because `routeRequest` swallows every
exception and a refusal raised inside it would never reach the client.

`RequestLog.scenario` records the scenario (`default` / `think` / `longContext`) or `passthrough`,
and Activity labels the column "Scenario". Older rows keep what their build wrote: the chain's
scenario names before v2.89.0, the requested tier (`fable` … `other`) from v2.89.0.

### The subagent tag

`<RIALTO-SUBAGENT-MODEL>…</RIALTO-SUBAGENT-MODEL>` (or the pre-rename `<CCR-SUBAGENT-MODEL>`) at the
start of the second system block **selects the `subagent` lane** of whichever scenario the request
falls into. Only its presence is read; its value is ignored. `stripSubagentTag`
(`src/llms/router/request-signals.ts`) strips a closed tag in place before anything else, in every
mode — the marker means nothing to any upstream — and returns whether it was there; a malformed
(unclosed) tag counts as present but is left in the prompt. The answer is recorded as
`RequestLog.isSubagent`. The tag lives in an Anthropic-shape `system` array — Claude Code's
convention — so requests on the OpenAI and Gemini surfaces, which carry their system prompt
elsewhere, always walk the agent lane ([inbound-parity.md](./inbound-parity.md)).

The lane's lists are ordinary lists: a subagent Think list with nothing usable falls back to the
subagent Default list, and an empty subagent Default passes the caller's model through. The
subagent lane never borrows the agent lane's routes. In v2.89.0 the tag selected nothing (the
requested-tier map had no lanes); the lane is back because it is where an operator puts the
smaller model subagents should use.

## Constraints

Stored in `RouterPreferenceProfile.constraints` and defaulted by `RoutingConstraintsSchema`:

| Key | Default | Meaning |
|---|---|---|
| `exhaustedBehavior` | `'429'` | What an exhausted list answers: 429 + `Retry-After`, or the caller's own model upstream |
| `quotaSkipPct` | `100` | Skip a route whose snapshot budget is used at or past this percentage |
| `errorRateSkipPct` | `0.5` | Skip a route whose 5-minute error rate is at or above this (0–1)… |
| `minHealthSamples` | `5` | …once it has at least this many samples |
| `longContextThreshold` | `null` | The tuner's value; `null` means the automatic base. See below |
| `previousLongContextThreshold` | `null` | The value before the tuner's last change, for its rollback |
| `longContextTunedAt` | `null` | ISO time of the tuner's last change |
| `autoTuneLongContext` | `true` | The tuner's kill switch. Not on the screen |

A blob that still carries retired keys (`allowEscalation`, `tierFallback`, the scheduler's scoring
knobs) parses; they are ignored, and a save merges the constraints over the blob rather than
replacing it, so a rollback to an older build still finds its own keys. A blob that does not parse
reads as the defaults.

## The Long context threshold

The input size over which a request is Long context. It is not an operator setting: it has an
automatic base, and the routing scheduler tunes it within a range below that base.

**The base** (`src/llms/tier-router/threshold.ts`) is 70 % (`LONG_CONTEXT_AUTO_RATIO`) of the
context window of the model the first usable `default` / `agent` route reaches — the first one
that is on, resolves to a model that is on, and has a known window — or 128 000
(`DEFAULT_LONG_CONTEXT_THRESHOLD`) when none does. The 30 % left over is room for the reply. The
base is recomputed on every read, so it follows the Default alias: point `sonnet` at a model with a
bigger window and the threshold moves with it.

**The value in effect** is the tuned value clamped to `[30 000, base]` (`LONG_CONTEXT_FLOOR`), or
the base when nothing is tuned. Never above the base: a request that big would not fit the Default
model it is being kept on. Never below 30 000: under that, ordinary coding turns would all count as
Long context. (A base below the floor wins over the floor.)

**The tuner** (`src/services/routing-scheduler/threshold-tuner.ts`). Long context is where an
operator puts the model they most want used — Fable, on most installs — and the threshold decides
how much traffic reaches it. So it moves the threshold by the pace of that route:

| The first usable `longContext` / `agent` route's `projectedPct` | Change |
|---|---|
| Below 60 | Lower by 20 % (not below the floor) — more requests qualify, so quota left over gets used |
| Above 100 | Raise by 20 % (not above the base) — fewer requests qualify |
| 60–100, or no reading | None |

Its guards, because an automatic change that is wrong costs quietly:

- It runs in the scheduler's **timer ticks** only — not in a republish after a Refresh — over every
  profile that has a Long context route, and changes a profile **at most once per 24 hours**.
- No reading, no change: a target the snapshot does not cover (an api_key provider), or a window
  less than 10 % elapsed, leaves the value alone.
- **Rollback.** If the last change was a lowering and, within the day, the snapshot reads that
  route exhausted, the value goes back to what it was before. Running out after a raise is not
  rolled back: raising was already the answer to running out.
- `constraints.autoTuneLongContext = false` stops it. It is not on the Routing screen; it is set
  with `PUT /api/routing/profiles/{key}`.
- Every change is logged at `info` (`[routing-scheduler] Long context threshold tuned`, with the
  profile, from, to, the reason and the pace reading). A failure is logged at `warn` and the tick
  carries on; the threshold simply stays where it was.

Its state is the three `longContext*` keys in `constraints`. **`saveTierProfile` keeps them from
the database** instead of taking them from the request: an editor saves the constraints it loaded,
and a tune that landed between that load and the save would otherwise be written back to what the
editor last saw. The consequence is that there is no manual threshold, not even through the API.
`GET /api/routing/profiles/{key}` returns the value in effect as `longContextThreshold`, beside the
raw `constraints`, so the screen can print "input over 700k tokens (auto)" without a second request.

## The quota snapshot

The routing scheduler (`src/services/routing-scheduler/`) publishes one reading per target —
**every enabled model of every enabled subscription provider**, not only those a profile names —
so every profile's routes are gated and paced on quota:

| Field | Meaning |
|---|---|
| `targets[].exhausted` | Every account behind the target reads as spent now. Only a fresh, known reading counts: an account never polled, or one gone stale, leaves the target open and the upstream's own 429 is the judge |
| `targets[].remainingBudgetPct` | Capacity-weighted remaining budget across the target's accounts, 0–100 (null with no fresh reading). An account's budget is its tighter of 5h / weekly; a Fable target reads the Fable-scoped weekly window |
| `targets[].projectedPct` | Pace: where the target lands at its reset, % of the budget (null until a window is far enough in to judge). See below |
| `targets[].resetAt` | When the budget next refills |
| `soonestResetAt` | The earliest reset across the exhausted targets |

**Pace** is `projectedUsage` in `quota-math.ts`:

- **Per window**, used % ÷ the share of the window elapsed — half spent half way through projects
  to exactly 100 %. A window is judged only once 10 % of it has passed (`PACE_MIN_ELAPSED`): early
  on, a handful of requests looks like a runaway pace.
- **Per account**, the tightest of the windows that bind the model — 5h and weekly, or, for a
  Fable target, Fable's own weekly window, as its budget does. An account never polled, or with a
  stale reading, is left out rather than read as idle.
- **Across accounts**, weighted by plan capacity (Pro 1 / Max 5 / Max 20, `planCapacityWeight`),
  because the account picker spreads a target's traffic over all of them and a Max 20 account
  carries twenty times what a Pro one does.

A spent account-wide window (5h or 7d; Codex primary / secondary) refuses every request on the
account, so the scheduler holds the account's other windows as spent too, until the last spent
account-wide window resets (`account-limit.ts`). Only in its own view: what is stored and shown is
the vendor's reading.

**When it is published.** A tick every `ROUTING_SCHEDULER_INTERVAL_MS` (default 5 minutes,
minimum 60 s; the first one an interval after boot), plus `republishRoutingSnapshot()` whenever
fresh quota has been written — the Providers screens' Refresh, a newly connected account, a spent
Codex reset, an alias promotion that switched a model on. Two ticks never overlap: a republish
queues behind a running tick, because the running one read `SubAccountQuota` before the write. A
failed tick keeps the previous snapshot. Timer ticks also run the Long context tuner.
`GET /api/routing-scheduler-state` serves the snapshot, `projectedPct` included.

**No weights.** The scheduler used to compute a weight per chain entry; the request path only ever
asked whether a weight was zero, and a damper made that answer lag the budget by up to five ticks.
It publishes the quota reading and the pace instead, and writes nothing to `RoutingWeightChange`.

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
  transaction; when that switch flipped, it also mirrors `Providers` to disk, drops the cached
  LLM context and republishes the quota snapshot, so the next request already reaches the model
  and is judged on its accounts. The picker offers every model of the provider, not only the
  name-matched candidates — otherwise a Codex or OpenAI model could never be aliased.
- **Unsetting** (`DELETE …/tier-aliases/{tier}`) leaves routes naming that tier skipped as
  `alias_unset` until one is set again. A Think or Long context list left with nothing usable falls
  back to Default; a Default list whose switched-on routes all lack an alias answers 400.
- **The alias moves the Long context base too** when it is the one the first usable
  `default` / `agent` route resolves through: the base is 70 % of that model's window.

## Editing and reading

| Endpoint | What it does |
|---|---|
| `GET /api/routing/profiles` | Every profile a surface or token can point at — `live` even before it has a row — plus the reserved `passthrough`, flagged as such |
| `GET /api/routing/profiles/{key}` | The profile's routes per scenario and lane, each resolved through its alias (`model`, `targetEnabled`, `hostsWebSearch`, `contextWindow`, or `null` when unset), its constraints, and `longContextThreshold` — the value in effect |
| `PUT /api/routing/profiles/{key}` | Whole-profile replacement in one transaction: routes per scenario and lane, and constraints. An unknown provider is dropped and a duplicate provider · tier in one list keeps its first place, both with a warning naming `scenario/lane`; an unset alias is kept and warned about. The tuner's three `longContext*` keys are kept from the database, whatever the body says. `passthrough` is refused (400) |
| `GET /api/tier-aliases` | Every provider's four tier slots, set or not, with candidates |
| `PUT` / `DELETE /api/providers/{name}/tier-aliases/{tier}` | Set (promote) / unset one alias |
| `GET /api/routing-scheduler-state` | The quota snapshot, pace included |

The Routing screen ([mocks/routing.html](../../mocks/routing.html) is its spec) picks a surface,
then its mode and profile, then shows the profile as one table: a row per scenario (Default, Think,
Long context — the last with the threshold in effect, "input over 700k tokens (auto)") and a column
per lane (Agent, Subagent). Each cell lists its routes top first, each line a provider and a tier
badge with an on/off switch, a drag handle and a remove button. Adding or changing a line is a
two-step dialog — the provider, then one of its tiers — in which a tier the provider has no model
for is disabled, because it would reach nothing. The screen shows no model names, no status or
quota column and no constraints block: the question an operator brings to it is which provider and
tier each scenario uses; which model that is belongs to the provider's page, and quota to Overview
and the provider pages.

`/api/router-preferences`, `/api/router-utilization` and `/api/solver-input` are gone, and so is the
per-model manual tier (`manualTier`) on the provider page and in the model PATCH.

## From the chain to scenario routes

`db seed` converts each profile's old chain once (`src/services/routing-migration/`);
[migration-v3.md](../guides/migration-v3.md) has the operator-facing version.

**Why it runs a second time.** v2.89.0 converted only the `default` / `agent` chain into the
requested-tier map, and its contract migration (#535) would have dropped the chain. #540 reverted
that, so production still has every lane of `RouterPreferenceEntry`. Migration
`20260925010000_key_tier_routes_by_scenario` then deletes every `TierRoute` row — a requested tier
is not a scenario, so those rows cannot be carried over — re-keys the table by `scenario` and
`lane`, and clears every profile's `chainBackfilledAt`, so the next seed converts every chain again.

- **When.** `entrypoint.sh` runs `prisma db seed` after `migrate deploy` on every start;
  `chainBackfilledAt` makes it once per profile, and a profile that already has routes (an operator
  got there first) is only marked. `live` goes first so the default profile claims the aliases.
- **Failure stops the container.** Each profile converts in its own transaction, but the error is not
  swallowed: carrying on would start the new build with that profile silently empty, every request
  on it passed through.
- **What it reads:** every entry of `default`, `think` and `longContext`, in both the `agent` and the
  `subagent` lane. Each becomes a route in the same list, in the same order, switched on or off as
  the entry was. There is no tier-gate conversion any more: the list already says which tiers serve
  it.
- **Which tier.** A route names the entry's provider and the tier its model is (the model's retired
  `manualTier` when set, else what the name says), and the provider's alias for that tier is claimed
  for the model when the slot is free. Claims go in rank order — a model whose name says a tier
  before one that does not, an entry that is on with its model and provider on before one that is
  not, then list order (`default/agent` first), priority, a non-deprecated model, the name. **An
  existing alias is never overwritten** — one another profile claimed, one `ensurePresetAliases` set,
  or one the operator set in v2.89.0 — and a route that now resolves to a different model than its
  entry named is noted.
- **Tierless models** (a `gpt-*` on Codex) are reached through a slot their provider already points
  at them, else the first free one of `sonnet` / `opus` / `haiku` / `fable`, else `sonnet` —
  through whatever model holds it, which the notes say.
- **Duplicates.** Two entries of one list that land on the same provider · tier become one route; a
  later one that is on rescues an earlier one that was off, at the later position, the way the chain
  would have run.
- **What it does not read:** the `webSearch` and `image` lists. They are no longer scenarios; their
  entries are counted in the notes.
- **What is lost:** edits made on the v2.89.0 tier-map screen. Those routes were keyed by requested
  tier and are the rows the migration deletes. Aliases set during v2.89.0 stay — the migration does
  not touch `ProviderTierAlias`.
- **Logged** as `[tier-routes] converted the chain into scenario routes`, with the counts and every
  note, per profile.
- **Re-running** one profile: `bun run scripts/rebackfill-tier-routes.ts --profile <key>` deletes its
  routes and clears its mark, and the next `bun run db:seed` converts the chain again. Aliases are
  left as they are. It exists for a rollback: while an older image runs, Routing edits land only in
  the old chain.

A later contract migration drops `RouterPreferenceEntry`, `RoutingWeightChange`, the `ScenarioKey` /
`RouterPreferenceKind` enums, `Model.manualTier` and `chainBackfilledAt`, together with the backfill
and its re-run script — once this build has run in production and every profile carries its mark.
Until then the backfill and the alias candidate list still read `Model.manualTier`.

## Tests

| Test | What it pins |
|---|---|
| `__tests__/llms/tier-router/select.test.ts` | The pure selector: the gates and their order, the four outcomes and which wins when skip reasons mix, and the pace ordering of the routes that pass |
| `__tests__/llms/tier-router/threshold.test.ts` | The Long context base (70 % of the Default model's window, 128k without one) and the clamp to `[floor, base]`, a base under the floor winning |
| `__tests__/llms/route-request.test.ts` | `routeRequest` end to end with seeded profiles: the scenario and lane a request is classified into, the fallback to the lane's Default, the outcome contract, profiles, marks, the snapshot, the subagent tag, the persona |
| `__tests__/api/route-plan.test.ts` | 429 + `Retry-After` and the refusal 400 in each surface's envelope |
| `__tests__/services/routing-scheduler/pace.test.ts` | `projectedUsage`: used ÷ elapsed, no judgement before 10 % of the window, the tightest window binding, Fable on its own window, plan-capacity weighting, unknown and stale accounts left out |
| `__tests__/services/routing-scheduler/threshold-tuner.test.ts` | `tuneThreshold`: ±20 % by pace, the floor and the base, no change on pace or without a reading, once a day, the rollback of a lowering and not of a raise |
| `__tests__/services/routing-scheduler/{targets,tick-targets,tick-concurrency}.test.ts` | The per-target reading, which targets are published, and that ticks never overlap |
| `__tests__/services/plan-tier-routes.test.ts` / `__tests__/db/backfill-tier-routes.test.ts` | The conversion planner, list by list, and its idempotence against the database |
| `__tests__/db/tier-route-service.test.ts` / `__tests__/db/tier-alias-service.test.ts` / `__tests__/api/routing-profiles.test.ts` | Storage, candidates, promotion and the API |

The full list is in [testing-map.md](./testing-map.md).

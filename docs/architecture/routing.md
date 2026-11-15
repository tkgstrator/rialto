# Where a request goes

Rialto does not route. A request goes to the model its caller named: `provider,model`, or a bare
public model id that resolves to the one provider that hosts it. There are no scenarios, lanes,
tiers or per-surface routing modes; every inbound surface behaves the same way. (Until v3 a surface
could be switched to `routed`, which picked the target from per-scenario "provider · tier" lists.
That whole mechanism, its tables and its screen were removed; see
[migration-v3.md](../guides/migration-v3.md) section 9.)

What is left between the wire and the upstream is a short, fixed sequence. The code is
`src/api/v1/route-plan.ts` (once per request) and `src/api/v1/chain-failover.ts` (once per
candidate).

## One request

1. **Authenticate and admit.** `src/api/api-key-auth.ts` checks the issued access token and then the
   plan's usage windows. A spent window answers 429 here. This runs before anything below, so a
   request refused later (step 2) still counts against the window.
2. **Plan model check** (`src/services/plan-model.ts`). Only for a token that has a plan:
   - the request names a model the plan lists: it is used (a bare name that several listed
     providers host stays bare and is resolved by provider priority in step 4);
   - the request names no model: the plan's `defaultModel` is used. This is the only time the
     default applies;
   - the request names a model the plan does not list: **403**, in the surface's own error shape
     (Anthropic `permission_error`, OpenAI `permission_error`, Google `PERMISSION_DENIED`), with a
     message that names the model and the allowed list. It is never redirected to the default.

   A token without a plan sends whatever the caller named. Image generation applies the same check
   inside `generateImage`, so `POST /v1/images/generations` and the `/codex` `generate_image` tool
   cannot disagree. The other `/codex` tools refuse a target the plan does not list
   (`src/api/codex-mcp/targets.ts`); they never fall back to a default.
3. **Stamp the request** (`src/llms/router.ts`, `routeRequest`). It strips the subagent tag from the
   second system block and records whether it was present (`RequestLog.isSubagent`; the tag's value
   is not read), and on `/v1/messages` it appends the active persona's prompt. It never rewrites
   `body.model`. The recorded scenario is always `passthrough`.
4. **Resolve a bare model name** to its provider: the providers that are enabled and host it, ordered
   by provider priority (`src/services/model-provider-preference.ts`), restricted to the providers
   the plan lists. Several hosts with no priority set is a 400.
5. **Surface deny list.** `InboundSurfaceConfig.deniedTargets` can refuse a `provider,model` on one
   surface (400). The list is stored per surface and read through a short cache
   (`src/services/inbound-surface-service.ts`); `/api/inbound-surfaces` reads and writes it.
6. **Walk the candidates** (`candidate-chain.ts`, `chain-failover.ts`). The chain is the resolved
   primary followed by the other providers of a bare name, skipping targets currently marked
   exhausted (never emptying the list). A subscription provider rotates across its accounts inside
   one candidate before the next candidate is tried. See [request-flow.md](./request-flow.md).

A model switched off, or a provider switched off, is not in the registry. It is hidden from `/v1/models`
and from the plan's model picker, a bare name never resolves to it, and a named `provider,model` finds no
invocation and is skipped — so nothing on it is ever sent. If no candidate is left the request gets a 400
`No usable model`.

## The quota snapshot

`src/services/routing-scheduler/` survived the removal of routing because two readers still need it:

- `providerExhaustionOf` in `chain-failover.ts` asks whether every account behind a provider is spent,
  so the walker can skip to the next candidate instead of sending a request that will 429;
- adaptive reasoning effort reads the pace (`projectedPct`), see
  [adaptive-reasoning-effort.md](./adaptive-reasoning-effort.md).

The scheduler publishes one reading per target (every enabled model of every enabled subscription
provider) into `getRoutingSnapshot()`:

| Field | Meaning |
|---|---|
| `targets[].exhausted` | Every account behind the target reads as spent now. Only a fresh, known reading counts; an account never polled, or one gone stale, leaves the target open and the upstream's own 429 is the judge |
| `targets[].remainingBudgetPct` | Capacity-weighted remaining budget across the target's accounts, 0 to 100 (null with no fresh reading). An account's budget is its tighter of 5h / weekly; a Fable target reads the Fable-scoped weekly window |
| `targets[].projectedPct` | Pace: where the target lands at its reset, as a percent of the budget (null until a window is far enough in to judge) |
| `targets[].resetAt` | When the budget next refills |

Pace is `projectedUsage` in `quota-math.ts`: per window, used % divided by the share of the window
elapsed (judged only once 10 % of it has passed); per account, the tightest of the windows that
bind the model; across accounts, weighted by plan capacity (Pro 1 / Max 5 / Max 20). A spent
account-wide window makes the scheduler hold the account's other windows as spent too, until the last
spent window resets (`account-limit.ts`); only its own view changes, not what is stored or shown.

A tick runs every `ROUTING_SCHEDULER_INTERVAL_MS` (default 5 minutes, minimum 60 s), and
`republishRoutingSnapshot()` runs one whenever fresh quota has been written (a Providers Refresh, a
newly connected account, a model switched on or off). Two ticks never overlap; a failed tick keeps
the previous snapshot. Nothing reorders candidates by the snapshot any more.

### Exhaustion marks

The reactive 429 path in `chain-failover.ts` writes in-process marks (`src/services/failover-state.ts`):

| Mark | Written when | Lifted when |
|---|---|---|
| Account | A subscription account 429s; until the binding window's reset, else 5 minutes | It expires; a request on that account succeeds; a Refresh reads the account below its limits |
| Model `(provider, model)` | No peer account is left to rotate to | It expires (5 minutes); a Refresh finds a freshly read account on the provider that can serve that model |
| Provider | `insufficient_quota` (an api_key spend cap) | It expires (5 minutes). Refresh never lifts it: no subscription reading speaks for an api_key cap |

Marks, the snapshot and the health ring are process-local; several instances do not share them. The
lifting on Refresh is `releaseRecoveredMarks` in `src/services/subscription-refresh-service.ts`.

## Tests

| Behavior | File |
|---|---|
| Plan decision (allowed, default, denied) | `__tests__/services/plan-model.test.ts` |
| 403 and the default on each plan-applying surface, bare-name resolution, the deny list | `__tests__/api/route-plan.test.ts` |
| Image generation applies the plan | `__tests__/api/openai-images.test.ts` |
| `/codex` refuses a target the plan does not list | `__tests__/api/codex-mcp.test.ts` |
| Subagent tag, persona | `__tests__/llms/router.test.ts` |
| Usage-window 429 | `__tests__/api/usage-windows.test.ts` |
| Quota snapshot, pace, account holds | `__tests__/services/routing-scheduler/` |

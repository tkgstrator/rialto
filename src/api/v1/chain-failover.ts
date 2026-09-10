/**
 * Fallback-chain walker with per-provider account rotation.
 *
 * For each model in the chain, `attemptChainEntry` runs the request
 * through the pipeline. On a 429:
 *   - If the failed call landed on a subscription provider AND we can
 *     identify the specific sub-account it used (via the sticky session
 *     map), `tryRotateAccount` marks just that account exhausted, drops
 *     the sticky, and re-runs the same chain entry — letting the
 *     session-account router pick a peer account on the next iteration.
 *   - Once the kind has no usable accounts left (or the failure wasn't
 *     subscription-related), the whole provider is marked exhausted and
 *     the walker advances to the next chain entry.
 *
 * Extracted from route.ts so the HTTP handler stays compact and the
 * cognitive-complexity budget isn't blown by the rotation logic.
 */

import type { Context } from 'hono'
import { type LlmsContext, subscriptionKindOf } from '../../llms'
import {
  isAccountExhausted,
  markAccountExhausted,
  markLongContextDenied,
  markModelExhausted,
  markProviderExhausted
} from '../../services/failover-state'
import { recordModelFailure, recordModelSuccess } from '../../services/routing-scheduler/model-health'
import { getActiveAccountForSession, releaseAccountForSession } from '../../services/session-account-router'
import { type AccountUsageMap, getPerAccountUsage, windowBinds } from '../../services/subaccount-usage-store'
import { getSubAccountTokensForKind } from '../../services/subscription-account-sync-service'
import { errorShapeForPath } from './error-shape'
import { type ResolvedInvocation, resolveInvocationForModel } from './invocation'
import type { RoutePlan } from './route-plan'
import { forwardUpstreamError, isInsufficientQuota, isLongContextGate, isRateLimited } from './upstream-error'

// Hard cap on account rotations within a single chain entry. Each rotate
// already requires an inbound 429 + an account-exhaustion mark, so a
// healthy subscription with N accounts will at worst rotate N-1 times.
// The cap exists purely to bound the loop when something goes wrong
// (mark didn't take, accounts vanished mid-flight) — not a tuning knob.
const MAX_ACCOUNT_ROTATIONS = 10

// Provider view the kind sniffer needs; aliased from scenario-router's
// public ConfigProvider so the route layer builds the same minimal shape
// it would have built inline.
export type SubscriptionKindProvider = Parameters<typeof subscriptionKindOf>[1][number]

// Constant-for-the-request data the chain walker and its helpers all
// need. Bundled so the inner functions take one ChainCtx arg instead of
// re-listing the same six fields each.
export type ChainCtx = {
  c: Context
  ctx: LlmsContext
  plan: RoutePlan
  providers: SubscriptionKindProvider[]
  // Resolved once per request by the route plan and never absent — the
  // OAuth transformer picked its sub-account under this same key, so the
  // rotation below can always look up which account just 429'd.
  sessionId: string
  attempt: (inv: ResolvedInvocation) => Promise<Response>
  errorResponse: (c: Context, err: unknown) => Response
}

// Outcome of trying one fallback chain entry. `done` means surface this
// response immediately (success / forwardable non-rate-limit error /
// pipeline error). `next` means advance to the next chain entry; when
// the failure carried a forwardable rate-limit body, it's attached so
// the outer walker can return it after the whole chain is exhausted.
export type ChainEntryOutcome = { kind: 'done'; response: Response } | { kind: 'next'; forwarded: Response | null }

// Run one chain entry — including any account-level rotations within
// the same subscription provider — and report whether to return now or
// advance.
export async function attemptChainEntry(chain: ChainCtx, model: string): Promise<ChainEntryOutcome> {
  const { c, ctx, plan, sessionId, attempt, errorResponse } = chain

  // Per-chain-entry account rotation state. A subscription provider can
  // carry multiple sub-accounts; a 5h rate-limit on one of them must
  // not knock out the whole provider while a peer account still has
  // capacity. `triedAccounts` guards against looping when an exhaustion
  // mark somehow doesn't take. The for-loop runs the initial attempt
  // plus at most MAX_ACCOUNT_ROTATIONS rotations.
  const triedAccounts = new Set<string>()
  let lastForwarded: Response | null = null
  // The long-context gate is a one-shot learning step per chain entry:
  // once the beta is dropped and marked, a second gate refusal would
  // mean something other than the beta is at fault, so don't loop on it.
  let longContextRetried = false

  for (let rotation = 0; rotation <= MAX_ACCOUNT_ROTATIONS; rotation++) {
    const inv = resolveInvocationForModel(plan, model, ctx)
    if (inv === null) return { kind: 'next', forwarded: lastForwarded }

    let err: unknown
    try {
      const response = await attempt(inv)
      // Success feeds the Phase 2e model-health tracker so the
      // quota-aware selector can down-weight targets showing high
      // error rates. Fire-and-forget: recording is a pure in-memory
      // update, but wrap in try/catch defensively.
      try {
        recordModelSuccess(`${inv.provider.name},${model}`)
      } catch {
        // Never let telemetry break the request path.
      }
      return { kind: 'done', response }
    } catch (caught) {
      err = caught
    }

    const forwarded = forwardUpstreamError(err, errorShapeForPath(plan.path), inv.provider.name)
    if (!forwarded) {
      ctx.log.error({ err }, 'pipeline error')
      return { kind: 'done', response: errorResponse(c, err) }
    }

    // Long-context gate: this plan can't serve the context-1m beta the
    // client opted into. Nothing else about the request is wrong, so
    // record the refusal and retry the SAME model/account — the next
    // resolveInvocationForModel rebuilds headers and prepareSubscriptionBetas
    // now strips the token. Failing over here would abandon a healthy
    // primary over a header, and surfacing the 429 would show the user a
    // quota error for a request that never hit a quota.
    if (!longContextRetried && isLongContextGate(err)) {
      longContextRetried = true
      const deniedAccount = getActiveAccountForSession(sessionId)
      markLongContextDenied(inv.provider.name, deniedAccount)
      ctx.log.warn(
        { provider: inv.provider.name, model: inv.request.model, subAccountId: deniedAccount },
        'long-context gate; dropping context-1m beta and retrying the same target'
      )
      continue
    }

    // Non-rate-limit upstream errors (auth, bad request, ...) surface
    // verbatim — re-routing those would hide real problems.
    if (!isRateLimited(err)) return { kind: 'done', response: forwarded }

    lastForwarded = forwarded

    // OpenAI's `insufficient_quota` is a permanent project spend-cap
    // breach, not an ephemeral rate-limit tick — retrying any sibling
    // model on the same provider will also 429, and the pipeline can
    // burn minutes ping-ponging through the fallback chain until the
    // outbound fetch abort-timer fires (observed in prod: 5+ min hangs
    // → 500). Mark the whole PROVIDER exhausted (default cooldown)
    // so isModelExhausted's provider-scope OR short-circuits every
    // remaining chain entry pointing at it, and advance to the next
    // provider in the chain immediately.
    if (isInsufficientQuota(err)) {
      markProviderExhausted(inv.provider.name)
      ctx.log.warn(
        { provider: inv.provider.name, model: inv.request.model, scenario: plan.scenarioType },
        'insufficient_quota; marking provider exhausted and failing over'
      )
      return { kind: 'next', forwarded: lastForwarded }
    }

    if (await tryRotateAccount(chain, inv, triedAccounts)) continue

    // Provider has no rotatable accounts left (or this isn't a
    // subscription provider): mark THIS model exhausted (not the whole
    // provider) so a same-provider fallback on a different model — the
    // classic Fable→Opus intra-account rescue — is still reachable.
    // isModelExhausted() consults both the model-scoped mark and the
    // coarser provider-scoped mark, so an explicit provider mark from
    // elsewhere still short-circuits every model. `inv.request.model`
    // is only optional at the type level (Anthropic pipeline can drop
    // it); when absent we can't mark a specific model, so skip.
    if (inv.request.model !== undefined) {
      markModelExhausted(inv.provider.name, inv.request.model)
      // Track the 429 in the Phase 2e model-health ring so the
      // quota-aware selector sees the failure at the same target
      // string it evaluates on.
      try {
        recordModelFailure(`${inv.provider.name},${inv.request.model}`)
      } catch {
        // Never let telemetry break the request path.
      }
    }
    ctx.log.warn(
      { provider: inv.provider.name, model: inv.request.model, scenario: plan.scenarioType },
      'rate limited; failing over to next fallback model'
    )
    return { kind: 'next', forwarded: lastForwarded }
  }

  // Rotation cap tripped (defensive — only reachable if exhaustion marks
  // somehow stop deduplicating). Treat as provider-exhausted.
  return { kind: 'next', forwarded: lastForwarded }
}

// How full a window has to be before the 429 we just saw is credited to
// it. Below this the window has headroom and cannot be what the upstream
// is enforcing, so reading its reset would park the account for a limit
// it never hit.
const NEAR_LIMIT_PCT = 90

/**
 * Pick the earliest future resetAt among the windows that could be
 * holding this account down, so the exhaustion mark clears exactly when
 * the upstream window rolls rather than after the default 5 minutes.
 *
 * Which windows count is decided by `windowBinds` against the model the
 * failed request asked for — the same function the account picker uses.
 * This used to walk a pinned key list of always-binding metrics, which
 * meant the per-model weekly windows were never consulted: Anthropic
 * meters Fable's allowance in `claude.seven_day_scoped.fable`, so a
 * Fable 429 matched nothing, fell through to the 5-minute default, and
 * the account was re-probed every 5 minutes for the rest of the week.
 * (The pinned list also named `seven_day_opus`, which most plans stopped
 * reporting, leaving it effectively two entries.)
 *
 * Returns undefined when no binding window is both near limit and has a
 * future reset — DB row missing, stale across its own reset, or the
 * upstream omitted the reset — in which case the caller keeps the
 * default cooldown.
 */
export function earliestResetUntil(
  usage: AccountUsageMap,
  kind: 'claude' | 'codex',
  requestedModel: string | undefined,
  now: number
): number | undefined {
  const resets: number[] = []
  for (const [metric, w] of usage) {
    if (!windowBinds(metric, kind, requestedModel)) continue
    if (w.percent < NEAR_LIMIT_PCT) continue
    if (w.resetAt === null) continue
    const at = w.resetAt.valueOf()
    if (at > now) resets.push(at)
  }
  return resets.length === 0 ? undefined : Math.min(...resets)
}

// One rotation step: when the failed invocation landed on a subscription
// provider and we know which sub-account it used, mark that account
// exhausted, drop the session sticky, and check whether the kind still
// has a usable peer. Returns true when the caller should retry the same
// chain entry, false when there's nothing to rotate to.
async function tryRotateAccount(
  chain: ChainCtx,
  inv: ResolvedInvocation,
  triedAccounts: Set<string>
): Promise<boolean> {
  const { ctx, plan, providers, sessionId } = chain
  const kind = subscriptionKindOf(inv.provider.name, providers)
  if (kind === null) return false

  const failedAcct = getActiveAccountForSession(sessionId)
  if (failedAcct === null || triedAccounts.has(failedAcct)) return false

  triedAccounts.add(failedAcct)
  // Pull the failed account's DB usage row so the exhaustion mark uses
  // the actual upstream resetAt (e.g. 47 minutes) rather than the
  // 5-minute default. This guarantees we don't re-probe the account
  // until its window genuinely rolls.
  const usageByAcct = await getPerAccountUsage([failedAcct])
  const usage = usageByAcct.get(failedAcct)
  // The model matters: it decides which per-model weekly windows are
  // candidates for having caused this 429.
  const until = usage !== undefined ? earliestResetUntil(usage, kind, inv.request.model, Date.now()) : undefined
  markAccountExhausted(failedAcct, until)
  releaseAccountForSession(sessionId, failedAcct)

  // Scope to `kind` (not the exact provider) because that mirrors what
  // the session-account router itself selects from.
  const tokens = await getSubAccountTokensForKind(kind)
  const anyUsable = tokens.some((t) => !isAccountExhausted(t.subAccountId))
  if (!anyUsable) return false

  ctx.log.warn(
    {
      provider: inv.provider.name,
      model: inv.request.model,
      scenario: plan.scenarioType,
      subAccountId: failedAcct,
      rotation: triedAccounts.size,
      exhaustedUntil: until ?? null
    },
    'rate limited on subscription account; rotating to peer account on same provider'
  )
  return true
}

/**
 * Pure preference-based selector (Phase 2c of the quota-aware router).
 *
 * Given an ordered preference chain, an optional request tier, and a
 * set of predicates (`isExhausted`, `errorRate`), return the first
 * candidate that passes every gate as `primary` and the remaining
 * passing candidates as `fallbacks`. The output is fed into the
 * existing `attemptChainEntry` machinery unchanged — this module NEVER
 * calls the network, the DB, or any effect.
 *
 * Gates applied per candidate (short-circuit order matters — cheap
 * checks first):
 *
 *   1. `entry.enabled` (soft toggle)
 *   2. Tier match (Open Question 1 / 11):
 *      - agent  call: `sonnetTierRespect` / `haikuTierRespect` when the
 *        client asked for that tier — candidate must be same tier.
 *      - subagent call: candidate's tier must be in
 *        `entry.subagentTiers` if that list is non-empty.
 *   3. Usage: `isExhausted(target)` returns true when the target's weight
 *      has dropped to zero or its known budget is used at or past the
 *      profile's `quotaSkipPct`.
 *   4. Recent error rate: `errorRate(target)` must be below the
 *      constraint's `errorRateSkipPct`; the check requires at least
 *      `minHealthSamples` recent samples (handled by the caller — this
 *      function trusts the callback).
 *
 * When the tier gate alone leaves nothing and `constraints.tierFallback`
 * is 'nearest', the candidates it refused get a second pass, nearest
 * tier first (see `nearestTierRetry`).
 *
 * All-candidates-fail: `primary: null`, and `skipped` says why. What the
 * caller answers — 429, 400, or the client's own model — depends on
 * those reasons and is decided in runtime.ts, not here.
 */

import type { PreferenceConstraints, RequestedModelTier, RouterPreferenceEntry } from '@/schemas/domain'
import { tierOf } from '../scenario-router/model-selection'

// Fable = 0 (top / most capable), haiku = 3 (bottom / cheapest).
// A candidate with a SMALLER index than the requested tier is
// "escalation" (client asked for a cheaper tier, offering a pricier
// one); a LARGER index is "demotion" (client asked for a pricier tier,
// offering a cheaper one). Mirrors the ordering in quota-router/runtime.ts.
const TIER_ORDER: readonly RequestedModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']

export interface PreferenceSelectorInput {
  entries: readonly RouterPreferenceEntry[]
  constraints: PreferenceConstraints
  requestedTier: RequestedModelTier | undefined
  isSubagent: boolean
  // Predicate: is this target out of usable budget right now? The request
  // path backs it with the scheduler snapshot — a zero weight, or a known
  // budget used at or past `quotaSkipPct`. Trusts the caller — this module
  // is pure.
  isExhausted: (target: string) => boolean
  // Recent error rate (0-1). Callers back with the Phase 2e
  // model-health tracker; Phase 2c can pass `() => 0`.
  errorRate: (target: string) => number
  // Model's max input tokens (from Model.contextWindow, mirrored on
  // the snapshot). Null = unknown (the vendor's page didn't publish it
  // or the model hasn't been scraped). Combined with `requestTokenCount`
  // below to drop candidates that physically can't serve the request.
  contextWindowOf?: (target: string) => number | null
  // Estimated input-token count for THIS request, used with
  // `contextWindowOf` to gate candidates whose max input is smaller.
  // Undefined disables the gate — legacy callers that don't tokenise
  // pre-selection keep the pre-Phase-2g behaviour.
  requestTokenCount?: number
  // Optional pace-aware tier widening (Phase 2f). When set, replaces
  // the strict same-tier check with membership in this set. The
  // runtime computes it by evaluating the requested tier's canonical
  // candidate paceRatio against the pace thresholds — if it is
  // over-paced the set becomes {requested, requestedMinusOne}, if
  // under-paced {requested, requestedPlusOne}, else {requested}. Undefined
  // preserves the pre-shift strict-tier behaviour (used by tests and by
  // requests where no snapshot data is available).
  allowedTiersOverride?: ReadonlySet<RequestedModelTier>
}

export interface PreferenceSelection {
  primary: string | null
  fallbacks: string[]
  // Whether the caller should skip the passthrough / 429 branch
  // because at least one candidate did pass every gate.
  matched: boolean
  // Machine-readable reasons per skipped candidate, in evaluation
  // order. Used by the shadow-mode divergence logger (Phase 2e) and
  // the utilization dashboard (later).
  skipped: { target: string; reason: SkipReason }[]
  // True when the primary came from the nearest-tier retry, i.e. the
  // request is being served by a tier the gates would have refused.
  substituted: boolean
}

export type SkipReason = 'disabled' | 'tier_mismatch' | 'exhausted' | 'error_rate' | 'context_too_small'

// Tier match: two directional gates. A candidate with a smaller
// TIER_ORDER index than the requested tier is an "escalation" (client
// asked for a cheaper tier, offering a pricier one); a larger index is
// a "demotion" (client asked for a pricier tier, offering a cheaper
// one). Same-tier candidates are always admissible. Unknown tiers
// (candidate name doesn't match any of fable/opus/sonnet/haiku, no
// manualTier override, requested tier unclassifiable) fall through as
// admissible — the alternative would evict every third-party model the
// operator explicitly configured.
//
// Precedence: per-entry `entryAllowEscalation` / `entryAllowDemotion`
// win when set (undefined = inherit the global constraint), so an
// operator can allow Opus-for-Sonnet without also allowing Fable-for-
// Sonnet even though both live in the same chain.
//
// Pace-aware widening: when `allowedTiersOverride` is provided the
// runtime has already decided which tiers are admissible based on the
// requested tier's current paceRatio. It takes precedence over the
// escalation/demotion gates (per-entry included) — the whole point of
// the override is to relax the tier constraint for a well-defined
// reason (burn slack budget / cool down over-paced tier).
const tierMatches = (
  candidateTier: RequestedModelTier | undefined,
  requestedTier: RequestedModelTier | undefined,
  constraints: PreferenceConstraints,
  allowedTiersOverride: ReadonlySet<RequestedModelTier> | undefined,
  entryAllowEscalation: boolean | undefined,
  entryAllowDemotion: boolean | undefined
): boolean => {
  if (allowedTiersOverride !== undefined && requestedTier !== undefined) {
    return candidateTier !== undefined && allowedTiersOverride.has(candidateTier)
  }
  if (candidateTier === undefined || requestedTier === undefined) return true
  if (candidateTier === requestedTier) return true
  const candidateIdx = TIER_ORDER.indexOf(candidateTier)
  const requestedIdx = TIER_ORDER.indexOf(requestedTier)
  if (candidateIdx < 0 || requestedIdx < 0) return true
  if (candidateIdx < requestedIdx) {
    return entryAllowEscalation !== undefined ? entryAllowEscalation : constraints.allowEscalation
  }
  return entryAllowDemotion !== undefined ? entryAllowDemotion : constraints.allowDemotion
}

// Extract the model name from a "providerName,modelName" target so
// `tierOf` can classify it. Returns undefined for malformed targets,
// which the caller's tier check will treat as "unknown tier" (skipped
// in strict mode, allowed otherwise).
const modelNameOf = (target: string): string | undefined => {
  const parts = target.split(',')
  if (parts.length !== 2) return undefined
  if (parts[1].length === 0) return undefined
  return parts[1]
}

// Manual tier override (Model.manualTier) wins when present so
// operators can classify third-party models that don't follow the
// fable/opus/sonnet/haiku naming convention. Name inference is the
// fallback for legacy targets that pre-date the override.
const candidateTierOf = (entry: RouterPreferenceEntry): RequestedModelTier | undefined => {
  if (entry.resolvedTier !== null && entry.resolvedTier !== undefined) return entry.resolvedTier
  const modelName = modelNameOf(entry.target)
  return modelName === undefined ? undefined : tierOf(modelName)
}

// The gates that describe a target's state right now, as opposed to
// whether it is the right tier. Shared by the first pass and the
// nearest-tier retry, so a substituted target is held to the same bar.
const runtimeGateOf = (target: string, input: PreferenceSelectorInput): SkipReason | null => {
  // Physical context window gate. A candidate whose max input is
  // smaller than the current request's token count would 400 or
  // silently truncate — skip it before the exhausted/error checks
  // so the reason is precise for the utilisation dashboard. Unknown
  // contextWindow (scraper miss / cold-start row) is treated as
  // "allow, we'll trust the vendor" rather than blocking the row.
  if (input.requestTokenCount !== undefined && input.contextWindowOf !== undefined) {
    const window = input.contextWindowOf(target)
    if (window !== null && window < input.requestTokenCount) return 'context_too_small'
  }
  if (input.isExhausted(target)) return 'exhausted'
  if (input.errorRate(target) >= input.constraints.errorRateSkipPct) return 'error_rate'
  return null
}

interface Refused {
  target: string
  tier: RequestedModelTier | undefined
  // Where the tier_mismatch sits in `skipped`, so the retry can replace
  // it with what actually happened to the candidate.
  skippedIndex: number
}

// Distance from the requested tier, cheaper side first on a tie: a
// Sonnet request with only Opus and Haiku in the chain takes Haiku
// before Opus. A candidate of unknown tier (only reachable through the
// pace override, which refuses those) sorts last.
const retryRank = (tier: RequestedModelTier | undefined, requested: RequestedModelTier): number => {
  const idx = tier === undefined ? -1 : TIER_ORDER.indexOf(tier)
  const requestedIdx = TIER_ORDER.indexOf(requested)
  if (idx < 0 || requestedIdx < 0) return Number.MAX_SAFE_INTEGER
  const distance = Math.abs(idx - requestedIdx)
  return distance * 2 + (idx < requestedIdx ? 1 : 0)
}

// Second pass over the candidates the tier gate refused, taken only when
// that gate is the reason nothing passed. The gates are a preference
// about which tier serves a request; left hard, a Sonnet-only chain with
// escalation off turned every Haiku call into a 429 that never went
// upstream. `Array.prototype.sort` is stable, so equal ranks keep chain
// order. A refused candidate that fails a runtime gate here reports that
// reason instead, so an exhausted substitute still reads as exhaustion.
function nearestTierRetry(
  refused: readonly Refused[],
  skipped: readonly { target: string; reason: SkipReason }[],
  input: PreferenceSelectorInput,
  requested: RequestedModelTier
): PreferenceSelection {
  const ordered = [...refused].sort((a, b) => retryRank(a.tier, requested) - retryRank(b.tier, requested))
  const outcome = new Map<number, SkipReason | null>(
    ordered.map((candidate) => [candidate.skippedIndex, runtimeGateOf(candidate.target, input)])
  )
  const passing = ordered.filter((candidate) => outcome.get(candidate.skippedIndex) === null).map((c) => c.target)
  const nextSkipped = skipped.flatMap((item, idx) => {
    const reason = outcome.get(idx)
    if (reason === undefined) return [item]
    return reason === null ? [] : [{ target: item.target, reason }]
  })
  if (passing.length === 0)
    return { primary: null, fallbacks: [], matched: false, skipped: nextSkipped, substituted: false }
  const [primary, ...fallbacks] = passing
  return { primary, fallbacks, matched: true, skipped: nextSkipped, substituted: true }
}

export function selectByPreference(input: PreferenceSelectorInput): PreferenceSelection {
  const passing: string[] = []
  const skipped: { target: string; reason: SkipReason }[] = []
  const refused: Refused[] = []

  for (const entry of input.entries) {
    if (!entry.enabled) {
      skipped.push({ target: entry.target, reason: 'disabled' })
      continue
    }
    const candidateTier = candidateTierOf(entry)

    if (
      !tierMatches(
        candidateTier,
        input.requestedTier,
        input.constraints,
        input.allowedTiersOverride,
        entry.allowEscalation,
        entry.allowDemotion
      )
    ) {
      refused.push({ target: entry.target, tier: candidateTier, skippedIndex: skipped.length })
      skipped.push({ target: entry.target, reason: 'tier_mismatch' })
      continue
    }

    const gated = runtimeGateOf(entry.target, input)
    if (gated !== null) {
      skipped.push({ target: entry.target, reason: gated })
      continue
    }

    passing.push(entry.target)
  }

  if (passing.length > 0) {
    const [primary, ...fallbacks] = passing
    return { primary, fallbacks, matched: true, skipped, substituted: false }
  }
  // The schema always fills `tierFallback`; constraints built by hand
  // (the selector tests) may leave it out, and absent reads as the
  // schema default rather than as 'refuse'.
  const nearest = input.constraints.tierFallback !== 'refuse'
  if (nearest && refused.length > 0 && input.requestedTier !== undefined) {
    return nearestTierRetry(refused, skipped, input, input.requestedTier)
  }
  return { primary: null, fallbacks: [], matched: false, skipped, substituted: false }
}

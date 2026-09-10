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
 *   3. Cached usage: `isExhausted(target)` returns true when the account
 *      is out of budget on any binding window.
 *   4. Recent error rate: `errorRate(target)` must be below the
 *      constraint's `errorRateSkipPct`; the check requires at least
 *      `minHealthSamples` recent samples (handled by the caller — this
 *      function trusts the callback).
 *
 * All-candidates-fail branches:
 *   - `constraints.exhaustedBehavior === '429'` → `primary: null`, caller
 *     is expected to return `rate_limit_error` with `Retry-After`.
 *   - `constraints.exhaustedBehavior === 'passthrough'` → `primary: null`
 *     and `fallbacks: []`, letting the caller keep the client's original
 *     model (L4 behaviour).
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
  // Predicate: does this account/model have zero remaining budget on
  // any binding window? The request path backs this with the
  // scheduler's weight snapshot. Trusts the caller — this module is
  // pure.
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

export function selectByPreference(input: PreferenceSelectorInput): PreferenceSelection {
  const passing: string[] = []
  const skipped: { target: string; reason: SkipReason }[] = []

  for (const entry of input.entries) {
    if (!entry.enabled) {
      skipped.push({ target: entry.target, reason: 'disabled' })
      continue
    }
    // Manual tier override (Model.manualTier) wins when present so
    // operators can classify third-party models that don't follow the
    // fable/opus/sonnet/haiku naming convention. Name inference is
    // the fallback for legacy targets that pre-date the override.
    const modelName = modelNameOf(entry.target)
    const inferredTier = modelName === undefined ? undefined : tierOf(modelName)
    const overrideTier =
      entry.resolvedTier === null || entry.resolvedTier === undefined ? undefined : entry.resolvedTier
    const candidateTier = overrideTier ?? inferredTier

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
      skipped.push({ target: entry.target, reason: 'tier_mismatch' })
      continue
    }

    // Physical context window gate. A candidate whose max input is
    // smaller than the current request's token count would 400 or
    // silently truncate — skip it before the exhausted/error checks
    // so the reason is precise for the utilisation dashboard. Unknown
    // contextWindow (scraper miss / cold-start row) is treated as
    // "allow, we'll trust the vendor" rather than blocking the row.
    if (input.requestTokenCount !== undefined && input.contextWindowOf !== undefined) {
      const window = input.contextWindowOf(entry.target)
      if (window !== null && window < input.requestTokenCount) {
        skipped.push({ target: entry.target, reason: 'context_too_small' })
        continue
      }
    }

    if (input.isExhausted(entry.target)) {
      skipped.push({ target: entry.target, reason: 'exhausted' })
      continue
    }

    if (input.errorRate(entry.target) >= input.constraints.errorRateSkipPct) {
      skipped.push({ target: entry.target, reason: 'error_rate' })
      continue
    }

    passing.push(entry.target)
  }

  if (passing.length === 0) {
    return { primary: null, fallbacks: [], matched: false, skipped }
  }
  const [primary, ...fallbacks] = passing
  return { primary, fallbacks, matched: true, skipped }
}

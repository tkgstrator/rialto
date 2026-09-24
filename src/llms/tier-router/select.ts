/**
 * Pick the routes that can serve one request, from its tier's list.
 *
 * Pure: the runtime resolves each route through its provider's alias and
 * hands in predicates for the live state (exhaustion, error rate). Never
 * touches the network or the database.
 *
 * There is no tier gate here. Which tiers may serve a request is written
 * in the map as routes; this only asks, of each route in order, whether it
 * can take this particular request right now:
 *
 *   1. the route and its target are switched on;
 *   2. its provider has an alias for the tier it names;
 *   3. it can run the request's web_search tool, if it carries one;
 *   4. its model's context window holds the prompt;
 *   5. its quota is not exhausted;
 *   6. its recent error rate is under the profile's threshold, once it
 *      has enough samples for the rate to mean anything.
 *
 * What an empty result means depends on why — see `TierOutcome`.
 */

import type { RoutingConstraints } from '@/schemas/domain/tier-route'

export interface TierCandidate {
  // "provider · tier", for logs and skip reasons.
  route: string
  // Resolved "provider,model", or null when the provider has no alias for
  // the tier the route names.
  target: string | null
  enabled: boolean
  // The model and its provider are both switched on.
  targetEnabled: boolean
  hostsWebSearch: boolean
  // Max input tokens, or null when unknown (trusted rather than blocked).
  contextWindow: number | null
}

export interface TierSelectInput {
  candidates: readonly TierCandidate[]
  constraints: RoutingConstraints
  needsWebSearch: boolean
  // Estimated prompt size; undefined skips the context gate.
  requestTokenCount: number | undefined
  isExhausted: (target: string) => boolean
  health: (target: string) => { errorRate: number; samples: number }
}

export type TierSkipReason =
  | 'disabled'
  | 'alias_unset'
  | 'no_web_search'
  | 'context_too_small'
  | 'exhausted'
  | 'error_rate'

/**
 *   - routed      a primary and the rest as fallbacks, in map order;
 *   - passthrough nothing usable because nothing is configured: no routes,
 *                 or every route or target switched off — the caller's own
 *                 model goes upstream, as an empty lane always meant;
 *   - exhausted   at least one route was held back by quota or health —
 *                 the profile's exhaustedBehavior decides 429 or pass;
 *   - refused     every route is configured but cannot take THIS request
 *                 (alias unset, no web search, prompt too big) — waiting
 *                 would not change that, so the answer is 400.
 */
export type TierOutcome = 'routed' | 'passthrough' | 'exhausted' | 'refused'

export interface TierSelection {
  outcome: TierOutcome
  primary: string | null
  fallbacks: string[]
  skipped: { route: string; reason: TierSkipReason }[]
  // Set when outcome is 'refused': why, in words a client can act on.
  refusal: string | null
}

const gateOf = (c: TierCandidate, input: TierSelectInput): TierSkipReason | null => {
  if (!c.enabled || !c.targetEnabled) return 'disabled'
  if (c.target === null) return 'alias_unset'
  if (input.needsWebSearch && !c.hostsWebSearch) return 'no_web_search'
  if (input.requestTokenCount !== undefined && c.contextWindow !== null && c.contextWindow < input.requestTokenCount) {
    return 'context_too_small'
  }
  if (input.isExhausted(c.target)) return 'exhausted'
  const health = input.health(c.target)
  if (health.samples >= input.constraints.minHealthSamples && health.errorRate >= input.constraints.errorRateSkipPct) {
    return 'error_rate'
  }
  return null
}

const REFUSAL_TEXT: Partial<Record<TierSkipReason, string>> = {
  alias_unset: 'a route names a provider tier that has no model aliased to it',
  no_web_search: 'the request carries the web_search tool, which no route here can run',
  context_too_small: 'the prompt does not fit the context window of any route'
}

export function selectTierRoute(input: TierSelectInput): TierSelection {
  const passing: string[] = []
  const skipped: TierSelection['skipped'] = []
  for (const candidate of input.candidates) {
    const reason = gateOf(candidate, input)
    if (reason === null && candidate.target !== null) passing.push(candidate.target)
    else if (reason !== null) skipped.push({ route: candidate.route, reason })
  }
  if (passing.length > 0) {
    const [primary, ...fallbacks] = passing
    return { outcome: 'routed', primary, fallbacks, skipped, refusal: null }
  }
  const reasons = new Set(skipped.map((s) => s.reason))
  const none = { primary: null, fallbacks: [], skipped }
  if (reasons.has('exhausted') || reasons.has('error_rate')) return { ...none, outcome: 'exhausted', refusal: null }
  const refusals = [...reasons].flatMap((r) => {
    const text = REFUSAL_TEXT[r]
    return text === undefined ? [] : [text]
  })
  if (refusals.length === 0) return { ...none, outcome: 'passthrough', refusal: null }
  return { ...none, outcome: 'refused', refusal: `No route can serve this request: ${refusals.join('; ')}.` }
}

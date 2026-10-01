/**
 * Pick the routes that can serve one request, from its scenario and
 * lane's list.
 *
 * Pure: the runtime resolves each route through its provider's alias and
 * hands in predicates for the live state (exhaustion, error rate). Never
 * touches the network or the database.
 *
 * The profile can forbid escalation into selected tiers. Same-tier routes
 * and demotions remain eligible. Each route is checked for whether it can take
 * this particular request right now:
 *
 *   1. the route and its target are switched on;
 *   2. its provider has an alias for the tier it names;
 *   3. it can run the request's web_search tool, if it carries one;
 *   4. its model's context window holds the prompt;
 *   5. its quota is not exhausted;
 *   6. its recent error rate is under the profile's threshold, once it
 *      has enough samples for the rate to mean anything.
 *
 * The routes that pass are then ordered by pace — where each target lands
 * at its quota reset if use keeps going as it has:
 *
 *   - well under budget (projected below PACE_SURPLUS_PCT) moves to the
 *     front, so quota the operator pays for is not left unused;
 *   - over it (above PACE_OVER_PCT) moves to the back, so the route below
 *     it — a lower tier, as the operator lists them — takes the traffic
 *     before the limit is hit;
 *   - the rest, and any target with no reading yet, keep list order.
 *
 * Within the surplus and even bands the list order holds. Within the over
 * band the route least over leads, and on a tie the lower tier: routes on
 * one subscription share its 5h and weekly windows, so its Opus and its
 * Sonnet always read the same pace and land in this band together — list
 * order alone would keep Opus in front and never step down, though Sonnet
 * spends the shared budget more slowly. A projection alone never refuses
 * a request: when every route is over pace, they all still serve, in
 * that order.
 *
 * Pace lowers the tier one step at most, and only from the top two: it may
 * put an Opus route ahead of a Fable one, or a Sonnet route ahead of an
 * Opus one, never Sonnet ahead of Fable nor anything ahead of Sonnet that
 * is below it. Past that the quality drop is worth more than the quota a
 * forecast says it would save. A route of the same or a higher tier may
 * always move ahead. Only pace is bound by this: the operator's own list
 * order, and a gate skipping a route, can still reach any tier.
 *
 * What an empty result means depends on why — see `TierOutcome`.
 */

import { REQUESTED_MODEL_TIERS } from '@/schemas/domain/router'
import type { ModelTier, RoutingConstraints } from '@/schemas/domain/tier-route'

export interface TierCandidate {
  // "provider · tier", for logs and skip reasons.
  route: string
  targetTier: ModelTier
  // Resolved "provider,model", or null when the provider has no alias for
  // the tier the route names.
  target: string | null
  enabled: boolean
  // The model and its provider are both switched on.
  targetEnabled: boolean
  hostsWebSearch: boolean
  // Max input tokens, or null when unknown (trusted rather than blocked).
  contextWindow: number | null
  // Projected use at the quota reset, % of the budget; null = no reading.
  projectedPct: number | null
}

// Projected use at the reset, as a percentage of the budget.
export const PACE_SURPLUS_PCT = 60
export const PACE_OVER_PCT = 100

type PaceBand = 'surplus' | 'even' | 'over'
const paceBandOf = (projectedPct: number | null): PaceBand => {
  if (projectedPct === null) return 'even'
  if (projectedPct < PACE_SURPLUS_PCT) return 'surplus'
  return projectedPct > PACE_OVER_PCT ? 'over' : 'even'
}
const BAND_ORDER: readonly PaceBand[] = ['surplus', 'even', 'over']

export interface TierSelectInput {
  requestedTier: ModelTier | undefined
  candidates: readonly TierCandidate[]
  constraints: RoutingConstraints
  needsWebSearch: boolean
  // Estimated prompt size; undefined skips the context gate.
  requestTokenCount: number | undefined
  isExhausted: (target: string) => boolean
  health: (target: string) => { errorRate: number; samples: number }
}

export type TierSkipReason =
  | 'escalation_blocked'
  | 'disabled'
  | 'alias_unset'
  | 'no_web_search'
  | 'context_too_small'
  | 'exhausted'
  | 'error_rate'

/**
 *   - routed      a primary and the rest as fallbacks, in pace order;
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
  selectedRoutes?: Array<{ target: string; targetTier: ModelTier; route: string }>
  fallbacks: string[]
  skipped: { route: string; reason: TierSkipReason }[]
  // Set when outcome is 'refused': why, in words a client can act on.
  refusal: string | null
  // Routes pace moved, for the log: pulled to the front, pushed back.
  paced: { promoted: string[]; steppedDown: string[] }
}

const gateOf = (c: TierCandidate, input: TierSelectInput): TierSkipReason | null => {
  if (!c.enabled || !c.targetEnabled) return 'disabled'
  if (c.target === null) return 'alias_unset'
  if (
    input.requestedTier !== undefined &&
    input.constraints.blockedEscalationTiers.includes(c.targetTier) &&
    REQUESTED_MODEL_TIERS.indexOf(c.targetTier) < REQUESTED_MODEL_TIERS.indexOf(input.requestedTier)
  ) {
    return 'escalation_blocked'
  }
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
  escalation_blocked: 'the profile forbids escalation from the requested tier into the available route tiers',
  alias_unset: 'a route names a provider tier that has no model aliased to it',
  no_web_search: 'the request carries the web_search tool, which no route here can run',
  context_too_small: 'the prompt does not fit the context window of any route'
}

const NOT_PACED = { promoted: [], steppedDown: [] }

// The tiers pace may step down from, one tier each (see the header).
const STEP_DOWN_FROM: readonly ModelTier[] = ['fable', 'opus']

// REQUESTED_MODEL_TIERS runs top tier first, so a higher index is a lower tier.
const tierIndex = (tier: ModelTier): number => REQUESTED_MODEL_TIERS.indexOf(tier)

// Whether pace may serve `later`, listed below `earlier`, ahead of it.
const mayServeAhead = (later: TierCandidate, earlier: TierCandidate): boolean => {
  const drop = tierIndex(later.targetTier) - tierIndex(earlier.targetTier)
  return drop <= 0 || (drop === 1 && STEP_DOWN_FROM.includes(earlier.targetTier))
}

// Over pace, the route least over goes first, then the lower tier (see the
// header). The other bands keep list order.
const overPaceOf = (band: PaceBand, projectedPct: number | null): number =>
  band === 'over' && projectedPct !== null ? projectedPct : 0
const overTierRank = (band: PaceBand, tier: ModelTier): number => (band === 'over' ? -tierIndex(tier) : 0)

type Banded = { c: TierCandidate; i: number; band: PaceBand }

// The order pace would like, before the step-down limit. Stable: list order
// breaks every tie.
const byPreference = (a: Banded, b: Banded): number =>
  BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band) ||
  overPaceOf(a.band, a.c.projectedPct) - overPaceOf(b.band, b.c.projectedPct) ||
  overTierRank(a.band, a.c.targetTier) - overTierRank(b.band, b.c.targetTier) ||
  a.i - b.i

function byPace(passing: readonly TierCandidate[]): { ordered: TierCandidate[]; paced: TierSelection['paced'] } {
  const banded = passing.map((c, i): Banded => ({ c, i, band: paceBandOf(c.projectedPct) }))
  const preferred = [...banded].sort(byPreference)
  // Place one route per step: the most preferred of those waiting that pace
  // may serve ahead of every route still waiting above it in the list. The
  // first waiting in list order always qualifies, so every route is placed.
  const ordered = banded.reduce<Banded[]>((placed) => {
    const waiting = preferred.filter((b) => !placed.includes(b))
    const next = waiting.find((b) => waiting.every((above) => above.i >= b.i || mayServeAhead(b.c, above.c)))
    return next === undefined ? placed : [...placed, next]
  }, [])
  // Where each route, by its list index, ends up.
  const position = banded.map((b) => ordered.indexOf(b))
  const overtook = (b: Banded): boolean => banded.some((above) => above.i < b.i && position[above.i] > position[b.i])
  const overtaken = (b: Banded): boolean => banded.some((below) => below.i > b.i && position[below.i] < position[b.i])
  return {
    ordered: ordered.map((b) => b.c),
    paced: {
      // A surplus route already at the front, or held behind a higher tier
      // by the step-down limit, was not moved.
      promoted: banded.filter((b) => b.band === 'surplus' && overtook(b)).map((b) => b.c.route),
      // An over-pace route something listed below it now serves ahead of:
      // a route on pace, one less over, or a lower tier on the same pace.
      steppedDown: banded.filter((b) => b.band === 'over' && overtaken(b)).map((b) => b.c.route)
    }
  }
}

export function selectTierRoute(input: TierSelectInput): TierSelection {
  const passing: TierCandidate[] = []
  const skipped: TierSelection['skipped'] = []
  for (const candidate of input.candidates) {
    const reason = gateOf(candidate, input)
    if (reason === null && candidate.target !== null) passing.push(candidate)
    else if (reason !== null) skipped.push({ route: candidate.route, reason })
  }
  if (passing.length > 0) {
    const { ordered, paced } = byPace(passing)
    const [primary, ...fallbacks] = ordered.flatMap((c) => (c.target === null ? [] : [c.target]))
    return {
      outcome: 'routed',
      primary,
      fallbacks,
      skipped,
      refusal: null,
      paced,
      selectedRoutes: ordered.flatMap((c) =>
        c.target === null ? [] : [{ target: c.target, targetTier: c.targetTier, route: c.route }]
      )
    }
  }
  const reasons = new Set(skipped.map((s) => s.reason))
  const none = { primary: null, fallbacks: [], skipped, paced: NOT_PACED }
  if (reasons.has('exhausted') || reasons.has('error_rate')) return { ...none, outcome: 'exhausted', refusal: null }
  const refusals = [...reasons].flatMap((r) => {
    const text = REFUSAL_TEXT[r]
    return text === undefined ? [] : [text]
  })
  if (refusals.length === 0) return { ...none, outcome: 'passthrough', refusal: null }
  return { ...none, outcome: 'refused', refusal: `No route can serve this request: ${refusals.join('; ')}.` }
}

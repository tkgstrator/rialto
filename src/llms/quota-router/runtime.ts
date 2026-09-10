/**
 * Runtime glue for the chain selector.
 *
 * `resolveQuotaAwareSelection()` composes:
 *
 *   scheduler snapshot (weights + soonestResetAt)
 *   +
 *   model-health tracker (errorRateOf)
 *
 * into the predicates `selectByPreference` needs (`isExhausted`,
 * `errorRate`, `contextWindowOf`), and turns an all-gated chain into the
 * Retry-After hint the /v1 handler answers with. `chainRoutingOf()`
 * projects the same loaded profile into what the classifier has to know
 * before the selector runs.
 */

import {
  type PreferenceConstraints,
  type QuotaAwareConstraints,
  QuotaAwareConstraintsSchema,
  type RequestedModelTier,
  type RouterPreferenceEntry,
  type RouterPreferenceProfile,
  type ScenarioKey
} from '@/schemas/domain'
import { DEFAULT_PROFILE_KEY, loadRoutableProfile } from '../../services/router-preference-service'
import { getRoutingSnapshot } from '../../services/routing-scheduler'
import { errorRateOf } from '../../services/routing-scheduler/model-health'
import type { ChainRouting } from '../scenario-router/model-selection'
import { tierOf } from '../scenario-router/model-selection'
import type { ConfigProvider } from '../scenario-router/types'
import { type PreferenceSelection, selectByPreference } from './selection'

// Consult the scheduler snapshot for the target. Returns true when the
// candidate is unusable *right now*: its weight has dropped to zero, or
// the budget the snapshot last saw is used at or past the profile's
// `quotaSkipPct`. A target whose budget is unknown (api_key providers, a
// subscription the collector has not reached yet) is not gated on usage.
// Without a snapshot yet (cold start) nothing is exhausted — the gate
// defers to the error-rate check and the reactive 429 path.
const buildIsExhausted = (quotaSkipPct: number): ((target: string) => boolean) => {
  const snapshot = getRoutingSnapshot()
  return (target: string): boolean => {
    if (snapshot === null) return false
    const entry = snapshot.weights.get(target)
    if (entry === undefined) return false
    if (entry.weight <= 0) return true
    return entry.remainingBudgetPct !== null && 100 - entry.remainingBudgetPct >= quotaSkipPct
  }
}

const buildErrorRate = (): ((target: string) => number) => (target) => errorRateOf(target)

// Look up the candidate's Model.contextWindow via the latest scheduler
// snapshot. Null when no snapshot exists yet or the candidate isn't in
// the snapshot (scraper hasn't reached that model) — the selector
// treats null as "allow" so the gate never becomes a hard block for
// fresh installs. Kept as a factory so the snapshot is read once per
// selection call.
const buildContextWindowOf = (): ((target: string) => number | null) => {
  const snapshot = getRoutingSnapshot()
  return (target: string): number | null => {
    if (snapshot === null) return null
    const window = snapshot.weights.get(target)?.contextWindow
    return window === undefined ? null : window
  }
}

// Tier navigation: fable > opus > sonnet > haiku (expensive → cheap).
// `tierBelow` returns the next-cheaper tier (used for downshift when
// the requested tier is over-paced); `tierAbove` returns the
// next-pricier tier (used for upshift when the requested tier has
// slack budget it won't burn on its own).
const TIER_ORDER: readonly RequestedModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']
const tierBelow = (t: RequestedModelTier): RequestedModelTier | undefined => {
  const idx = TIER_ORDER.indexOf(t)
  return idx < 0 || idx === TIER_ORDER.length - 1 ? undefined : TIER_ORDER[idx + 1]
}
const tierAbove = (t: RequestedModelTier): RequestedModelTier | undefined => {
  const idx = TIER_ORDER.indexOf(t)
  return idx <= 0 ? undefined : TIER_ORDER[idx - 1]
}

// Pace-aware tier widening. Given the requested tier and the chain, look
// up the paceRatio of the top enabled candidate matching that tier in
// the snapshot and decide whether to admit an adjacent tier for this
// request. Returns undefined when there is no snapshot data, the
// window has barely started (early-window noise), or the pace sits
// inside the neutral band. In every "undefined" case the caller
// preserves the strict-tier behaviour.
const resolveAllowedTiers = (
  requestedTier: RequestedModelTier | undefined,
  entries: readonly RouterPreferenceEntry[],
  constraints: PreferenceConstraints
): ReadonlySet<RequestedModelTier> | undefined => {
  if (requestedTier === undefined) return undefined
  const snapshot = getRoutingSnapshot()
  if (snapshot === null) return undefined
  const canonical = entries.find((e) => e.enabled && e.resolvedTier === requestedTier)
  if (canonical === undefined) return undefined
  const entry = snapshot.weights.get(canonical.target)
  if (entry === undefined) return undefined
  if (entry.paceRatio === null || entry.windowElapsedRatio === null) return undefined
  if (entry.windowElapsedRatio * 100 < constraints.pacePolicyMinElapsedPct) return undefined
  if (entry.paceRatio > constraints.paceOverThreshold) {
    const below = tierBelow(requestedTier)
    return below === undefined ? undefined : new Set<RequestedModelTier>([requestedTier, below])
  }
  if (entry.paceRatio < constraints.paceUnderThreshold) {
    const above = tierAbove(requestedTier)
    return above === undefined ? undefined : new Set<RequestedModelTier>([requestedTier, above])
  }
  return undefined
}

// Model.contextWindow behind a "provider,model" target, read off the flat
// runtime provider list. The model serving the default lane is the
// chain's first enabled entry, so this is what the longContext
// auto-threshold has to track.
const contextWindowOf = (providers: readonly ConfigProvider[], target: string): number | null => {
  const comma = target.indexOf(',')
  if (comma <= 0) return null
  const provider = providers.find((p) => p.name === target.slice(0, comma))
  const window = provider?.modelContextWindows?.[target.slice(comma + 1)]
  return typeof window === 'number' && window > 0 ? window : null
}

// The profile's constraint blob, parsed through the schema so every
// knob has its default. A blob that fails to parse (hand-edited JSONB)
// falls back to the defaults rather than taking routing down.
const constraintsOf = (profile: RouterPreferenceProfile): QuotaAwareConstraints => {
  const parsed = QuotaAwareConstraintsSchema.safeParse(profile.constraints === null ? {} : profile.constraints)
  return parsed.success ? parsed.data : QuotaAwareConstraintsSchema.parse({})
}

/**
 * Project a loaded profile into what the scenario classifier needs.
 *
 * The classifier runs before the selector and decides which lane the
 * selector will then be asked for, so it has to know the chain's shape
 * up front — which lanes carry an enabled entry, how big the model on
 * the default lane is, and whether the operator pinned the longContext
 * threshold. Built from an already-loaded profile so the request path
 * reads the row once for both jobs.
 *
 * A lane with entries that are all disabled does NOT count: the
 * selector would skip every one of them and return no primary, and
 * classifying into a lane that resolves to nothing is the exact failure
 * the gate exists to prevent.
 */
export function chainRoutingOf(profile: RouterPreferenceProfile, providers: readonly ConfigProvider[]): ChainRouting {
  const top = profile.entriesByScenario.default.agent.find((entry) => entry.enabled)
  return {
    hasLane: (kind, scenario) => profile.entriesByScenario[scenario][kind].some((entry) => entry.enabled),
    defaultAgentContextWindow: top === undefined ? null : contextWindowOf(providers, top.target),
    longContextThreshold: constraintsOf(profile).longContextThreshold
  }
}

export interface QuotaAwareSelectionInput {
  requestedModel: string | undefined
  isSubagent: boolean
  scenario: ScenarioKey
  // Which RouterPreferenceProfile the chain comes from. Resolved from
  // the request's inbound surface, so two surfaces can run different
  // chains — a CI token's surface on cost-first while interactive
  // traffic stays on the default. Omitted = the default profile.
  profileKey?: string
  // Estimated input-token count for this request. The scenario router
  // computes it via tokenizers/base before classification; passing it
  // through lets the selector's context-window gate skip candidates
  // that can't physically hold the request. Undefined = don't gate.
  requestTokenCount?: number
  // The profile the caller already loaded, when it had to read it before
  // classification (see `chainRoutingOf`). Reusing it keeps the request
  // path at one Prisma read; omitted, this loads `profileKey` itself.
  profile?: RouterPreferenceProfile
}

export interface QuotaAwareSelection {
  selection: PreferenceSelection
  retryAfterSec: number | null
}

export async function resolveQuotaAwareSelection(input: QuotaAwareSelectionInput): Promise<QuotaAwareSelection> {
  // Per-kind chain lookup: `agent` for main-agent traffic, `subagent`
  // for requests carrying a <RIALTO-SUBAGENT-MODEL> tag. The two chains
  // are ordered independently in the DB, so the same scenario can
  // route very differently based on the caller lane.
  const kind = input.isSubagent ? 'subagent' : 'agent'
  const profile =
    input.profile !== undefined
      ? input.profile
      : await loadRoutableProfile(input.profileKey === undefined ? DEFAULT_PROFILE_KEY : input.profileKey)
  const entries = profile.entriesByScenario[input.scenario][kind]
  const constraints = constraintsOf(profile)
  // Empty-lane shortcut: no entries for this (scenario, kind) means the
  // operator has not configured this lane. That is "no opinion", not
  // "everything is exhausted", so the caller keeps the client's own
  // model and `exhaustedBehavior: '429'` is deliberately NOT consulted —
  // the 429 branch is for real chains whose candidates are all currently
  // gated. Without this a fresh install with a '429' profile and no
  // entries would refuse every request.
  if (entries.length === 0) {
    return { selection: { primary: null, fallbacks: [], matched: false, skipped: [] }, retryAfterSec: null }
  }
  const l4Constraints: PreferenceConstraints = constraints
  const requestedTier = input.requestedModel ? tierOf(input.requestedModel) : undefined
  // Pace-based widening only applies to agent calls — the subagent lane
  // is ordered by hand for exactly that traffic, and blurring it
  // silently would surprise the operator who pinned it.
  const allowedTiersOverride = input.isSubagent ? undefined : resolveAllowedTiers(requestedTier, entries, l4Constraints)
  const selection = selectByPreference({
    entries,
    constraints: l4Constraints,
    requestedTier,
    isSubagent: input.isSubagent,
    isExhausted: buildIsExhausted(constraints.quotaSkipPct),
    errorRate: buildErrorRate(),
    contextWindowOf: buildContextWindowOf(),
    requestTokenCount: input.requestTokenCount,
    allowedTiersOverride
  })
  // Retry-After hint is populated ONLY when (a) the selector produced
  // no primary AND (b) constraints.exhaustedBehavior is '429'. The
  // caller uses null-vs-number to decide between "return 429" and
  // "keep the caller's own model".
  const snapshot = getRoutingSnapshot()
  const shouldEmit429 = selection.primary === null && constraints.exhaustedBehavior === '429'
  const retryAfterSec = shouldEmit429 ? retryAfterFrom(snapshot?.soonestResetAt) : null
  return { selection, retryAfterSec }
}

// Seconds until the earliest binding-window reset, or the L4 default
// (30 s, matching Anthropic's typical retry hint for a soft 429) when no
// snapshot has published one yet.
const retryAfterFrom = (soonestResetAt: number | null | undefined): number => {
  if (soonestResetAt === null || soonestResetAt === undefined) return 30
  return Math.max(1, Math.ceil((soonestResetAt - Date.now()) / 1000))
}

// Adapter helpers for the request pipeline, re-exported so the /v1 chain
// walker reaches the model-health tracker through the selector's own
// module.
export {
  recordModelFailure,
  recordModelSuccess
} from '../../services/routing-scheduler/model-health'

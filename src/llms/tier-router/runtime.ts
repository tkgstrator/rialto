/**
 * Runtime glue for scenario routing: load the profile, classify the
 * request, and ask the pure selector with predicates built from live
 * state.
 *
 *   scenario routes + aliases (tier-route-service, one read per request)
 *   + exhaustion marks (failover-state, written by the 429 path)
 *   + quota snapshot and pace (routing-scheduler, published per tick)
 *   + model health (model-health, recent failures)
 *
 * The scenario comes from the request itself — input over the Long
 * context threshold, thinking on, or neither — and the lane from the
 * subagent tag. The model name the caller sent plays no part: the list
 * says which provider tiers serve the scenario.
 */

import type { RoutingConstraints, RoutingLane, RoutingScenario } from '@/schemas/domain/tier-route'
import { exhaustedUntil, isModelExhausted } from '../../services/failover-state'
import { getRoutingSnapshot } from '../../services/routing-scheduler'
import { errorRateOf, sampleCountOf } from '../../services/routing-scheduler/model-health'
import {
  defaultAgentWindowOf,
  loadTierProfileView,
  type TierProfileView,
  type TierRouteView
} from '../../services/tier-route-service'
import { selectTierRoute, type TierCandidate, type TierSelection } from './select'
import { effectiveLongContextThreshold, longContextBase } from './threshold'

// Profiles seeded by a test in place of the database; `null` reads the
// database, the only state production sees. A key mapped to an Error makes
// the load throw — "the database is away".
type SeededProfiles = Partial<Record<string, TierProfileView | Error>>
const seeded: { value: SeededProfiles | null } = { value: null }

export function __setTierProfilesForTests(profiles: SeededProfiles | null): void {
  seeded.value = profiles
}

const emptyView = (key: string): TierProfileView => ({
  key,
  routes: {
    default: { agent: [], subagent: [] },
    think: { agent: [], subagent: [] },
    longContext: { agent: [], subagent: [] }
  },
  constraints: {
    exhaustedBehavior: '429',
    quotaSkipPct: 100,
    errorRateSkipPct: 0.5,
    minHealthSamples: 5,
    longContextThreshold: null,
    previousLongContextThreshold: null,
    longContextTunedAt: null,
    autoTuneLongContext: true
  },
  longContextThreshold: longContextBase(null)
})

async function loadView(profileKey: string): Promise<TierProfileView> {
  if (seeded.value === null) return loadTierProfileView(profileKey)
  const view = seeded.value[profileKey]
  if (view instanceof Error) throw view
  return view === undefined ? emptyView(profileKey) : view
}

// A list has something to offer when at least one route is on and
// resolves to a model that is on. Otherwise the scenario is skipped for
// Default in the same lane — "no opinion", not "everything is exhausted".
const hasUsableRoute = (routes: readonly TierRouteView[]): boolean =>
  routes.some((r) => r.enabled && r.resolved !== null && r.resolved.targetEnabled)

export interface Classification {
  scenario: RoutingScenario
  lane: RoutingLane
  // The Long context threshold the request was measured against.
  threshold: number
}

/**
 * Long input first — a long prompt is Long context whether or not it asks
 * to think — then thinking, then Default; the lane from the subagent tag.
 * A scenario whose list has nothing usable in the lane falls back to
 * Default for that lane.
 */
export function classify(
  view: TierProfileView,
  signals: { requestTokenCount: number | undefined; thinking: boolean; isSubagent: boolean }
): Classification {
  const threshold = effectiveLongContextThreshold(
    view.constraints.longContextThreshold,
    longContextBase(defaultAgentWindowOf(view.routes))
  )
  const lane: RoutingLane = signals.isSubagent ? 'subagent' : 'agent'
  const long = signals.requestTokenCount !== undefined && signals.requestTokenCount > threshold
  const wanted: RoutingScenario = long ? 'longContext' : signals.thinking ? 'think' : 'default'
  const scenario = wanted !== 'default' && !hasUsableRoute(view.routes[wanted][lane]) ? 'default' : wanted
  return { scenario, lane, threshold }
}

const splitTarget = (target: string): { provider: string; model: string } | null => {
  const comma = target.indexOf(',')
  return comma <= 0 ? null : { provider: target.slice(0, comma), model: target.slice(comma + 1) }
}

// Out of use right now: a mark from a 429 on this model or its provider, or
// the quota snapshot's reading — spent, or used at or past the profile's
// quotaSkipPct. A target the snapshot has never seen (api_key providers, a
// cold start) is not held on quota.
const buildIsExhausted = (quotaSkipPct: number): ((target: string) => boolean) => {
  const snapshot = getRoutingSnapshot()
  return (target) => {
    const parts = splitTarget(target)
    if (parts !== null && isModelExhausted(parts.provider, parts.model)) return true
    const quota = snapshot === null ? undefined : snapshot.targets.get(target)
    if (quota === undefined) return false
    if (quota.exhausted) return true
    return quota.remainingBudgetPct !== null && 100 - quota.remainingBudgetPct >= quotaSkipPct
  }
}

// When one held-back target can serve again: its mark's deadline when a
// 429 set one, else the snapshot's reset for it.
const backAt = (target: string): number | null => {
  const parts = splitTarget(target)
  const until = parts === null ? null : exhaustedUntil(parts.provider, parts.model)
  if (until !== null) return until
  const snapshot = getRoutingSnapshot()
  const quota = snapshot === null ? undefined : snapshot.targets.get(target)
  return quota === undefined ? null : quota.resetAt
}

// Seconds until the first held-back route of the tier can serve again, or
// Anthropic's usual 30 s for a soft 429 when none of them says.
const retryAfterFor = (selection: TierSelection, candidates: readonly TierCandidate[], now: number): number => {
  const held = new Set(selection.skipped.filter((s) => s.reason === 'exhausted').map((s) => s.route))
  const deadlines = candidates.flatMap((c) => {
    if (!held.has(c.route) || c.target === null) return []
    const at = backAt(c.target)
    return at === null || at <= now ? [] : [at]
  })
  if (deadlines.length === 0) return 30
  return Math.max(1, Math.ceil((Math.min(...deadlines) - now) / 1000))
}

export interface TierRouting {
  classification: Classification
  selection: TierSelection
  constraints: RoutingConstraints
  // Set only for an exhausted tier under exhaustedBehavior '429'.
  retryAfterSec: number | null
}

export interface TierRoutingInput {
  profileKey: string
  requestTokenCount: number | undefined
  thinking: boolean
  isSubagent: boolean
  needsWebSearch: boolean
}

// Projected use at the reset, from the snapshot; null for a target it has
// no reading for (api_key providers, a cold start).
const projectedPctOf = (target: string | null): number | null => {
  const snapshot = getRoutingSnapshot()
  const quota = target === null || snapshot === null ? undefined : snapshot.targets.get(target)
  return quota === undefined ? null : quota.projectedPct
}

export async function routeByScenario(input: TierRoutingInput): Promise<TierRouting> {
  const view = await loadView(input.profileKey)
  const classification = classify(view, input)
  const routes = view.routes[classification.scenario][classification.lane]
  const candidates: TierCandidate[] = routes.map((route) => ({
    route: `${route.provider} · ${route.targetTier}`,
    target: route.resolved === null ? null : `${route.provider},${route.resolved.model}`,
    enabled: route.enabled,
    targetEnabled: route.resolved === null ? true : route.resolved.targetEnabled,
    hostsWebSearch: route.resolved === null ? false : route.resolved.hostsWebSearch,
    contextWindow: route.resolved === null ? null : route.resolved.contextWindow,
    projectedPct: projectedPctOf(route.resolved === null ? null : `${route.provider},${route.resolved.model}`)
  }))
  const selection = selectTierRoute({
    candidates,
    constraints: view.constraints,
    needsWebSearch: input.needsWebSearch,
    requestTokenCount: input.requestTokenCount,
    isExhausted: buildIsExhausted(view.constraints.quotaSkipPct),
    health: (target) => ({ errorRate: errorRateOf(target), samples: sampleCountOf(target) })
  })
  const answers429 = selection.outcome === 'exhausted' && view.constraints.exhaustedBehavior === '429'
  return {
    classification,
    selection,
    constraints: view.constraints,
    retryAfterSec: answers429 ? retryAfterFor(selection, candidates, Date.now()) : null
  }
}

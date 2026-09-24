/**
 * Runtime glue for the tier map: load it, resolve the request's tier, and
 * ask the pure selector with predicates built from live state.
 *
 *   tier map + aliases (tier-route-service, one read per request)
 *   + exhaustion marks (failover-state, written by the 429 path)
 *   + quota snapshot (routing-scheduler, published per tick)
 *   + model health (model-health, recent failures)
 *
 * The request's tier is what its model name says (`tierOf`), or "other".
 * Nothing here decides which tiers may serve which: the map says so.
 */

import type { RouteTier, RoutingConstraints } from '@/schemas/domain/tier-route'
import { exhaustedUntil, isModelExhausted } from '../../services/failover-state'
import { getRoutingSnapshot } from '../../services/routing-scheduler'
import { errorRateOf, sampleCountOf } from '../../services/routing-scheduler/model-health'
import { loadTierProfileView, type TierProfileView } from '../../services/tier-route-service'
import { tierOf } from '../scenario-router/request-signals'
import { selectTierRoute, type TierCandidate, type TierSelection } from './select'

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
  routes: { fable: [], opus: [], sonnet: [], haiku: [], other: [] },
  constraints: { exhaustedBehavior: '429', quotaSkipPct: 100, errorRateSkipPct: 0.5, minHealthSamples: 5 }
})

async function loadView(profileKey: string): Promise<TierProfileView> {
  if (seeded.value === null) return loadTierProfileView(profileKey)
  const view = seeded.value[profileKey]
  if (view instanceof Error) throw view
  return view === undefined ? emptyView(profileKey) : view
}

/** The tier a requested model name asks for; "other" when it names no Claude family. */
export function requestedTierOf(model: string | undefined): RouteTier {
  const tier = model === undefined ? undefined : tierOf(model)
  return tier === undefined ? 'other' : tier
}

const splitTarget = (target: string): { provider: string; model: string } | null => {
  const comma = target.indexOf(',')
  return comma <= 0 ? null : { provider: target.slice(0, comma), model: target.slice(comma + 1) }
}

// Out of use right now: a mark from a 429 on this model or its provider, or
// the quota snapshot's reading — a zero weight, or a budget used at or past
// the profile's quotaSkipPct. A target the snapshot has never seen (api_key
// providers, a cold start) is not held on quota.
const buildIsExhausted = (quotaSkipPct: number): ((target: string) => boolean) => {
  const snapshot = getRoutingSnapshot()
  return (target) => {
    const parts = splitTarget(target)
    if (parts !== null && isModelExhausted(parts.provider, parts.model)) return true
    const entry = snapshot === null ? undefined : snapshot.weights.get(target)
    if (entry === undefined) return false
    if (entry.weight <= 0) return true
    return entry.remainingBudgetPct !== null && 100 - entry.remainingBudgetPct >= quotaSkipPct
  }
}

// Seconds until the first held-back route of the tier can serve again: the
// earliest of their marks' deadlines, else the snapshot's soonest reset,
// else Anthropic's usual 30 s for a soft 429.
const retryAfterFor = (selection: TierSelection, candidates: readonly TierCandidate[], now: number): number => {
  const held = new Set(selection.skipped.filter((s) => s.reason === 'exhausted').map((s) => s.route))
  const deadlines = candidates.flatMap((c) => {
    if (!held.has(c.route) || c.target === null) return []
    const parts = splitTarget(c.target)
    const until = parts === null ? null : exhaustedUntil(parts.provider, parts.model)
    return until === null ? [] : [until]
  })
  const snapshot = getRoutingSnapshot()
  const soonest =
    deadlines.length > 0 ? Math.min(...deadlines) : snapshot === null ? null : snapshot.soonestResetAt
  if (soonest === null) return 30
  return Math.max(1, Math.ceil((soonest - now) / 1000))
}

export interface TierRouting {
  requestedTier: RouteTier
  selection: TierSelection
  constraints: RoutingConstraints
  // Set only for an exhausted tier under exhaustedBehavior '429'.
  retryAfterSec: number | null
}

export interface TierRoutingInput {
  requestedModel: string | undefined
  profileKey: string
  requestTokenCount: number | undefined
  needsWebSearch: boolean
}

export async function routeByTier(input: TierRoutingInput): Promise<TierRouting> {
  const view = await loadView(input.profileKey)
  const requestedTier = requestedTierOf(input.requestedModel)
  const candidates: TierCandidate[] = view.routes[requestedTier].map((route) => ({
    route: `${route.provider} · ${route.targetTier}`,
    target: route.resolved === null ? null : `${route.provider},${route.resolved.model}`,
    enabled: route.enabled,
    targetEnabled: route.resolved === null ? true : route.resolved.targetEnabled,
    hostsWebSearch: route.resolved === null ? false : route.resolved.hostsWebSearch,
    contextWindow: route.resolved === null ? null : route.resolved.contextWindow
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
    requestedTier,
    selection,
    constraints: view.constraints,
    retryAfterSec: answers429 ? retryAfterFor(selection, candidates, Date.now()) : null
  }
}

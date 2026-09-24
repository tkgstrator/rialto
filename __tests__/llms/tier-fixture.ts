/**
 * Scenario routes for tests.
 *
 * `route('claude-code', 'sonnet', 'claude-sonnet-5')` is a route to the
 * provider's sonnet alias, resolved to that model; a null model is an
 * unset alias. `mapWith({ default: { agent: [...] }, think: { subagent: [...] } })`
 * places routes by scenario and lane into the view the router reads; the
 * lists not named stay empty, which is the shape a partially configured
 * install has. Seed it with `__setTierProfilesForTests`.
 *
 * `profileWith` is the same sparse description in the stored shape, for
 * the tests that save a profile to the database.
 */

import { effectiveLongContextThreshold, longContextBase } from '../../src/llms/tier-router/threshold'
import type {
  RoutingConstraints,
  RoutingLane,
  RoutingScenario,
  TierProfile,
  TierRoute
} from '../../src/schemas/domain/tier-route'
import {
  defaultAgentWindowOf,
  type ScenarioRouteViews,
  type TierProfileView,
  type TierRouteView
} from '../../src/services/tier-route-service'

interface RouteOptions {
  enabled?: boolean
  targetEnabled?: boolean
  hostsWebSearch?: boolean
  contextWindow?: number | null
}

export function route(
  provider: string,
  targetTier: TierRouteView['targetTier'],
  model: string | null,
  options: RouteOptions = {}
): TierRouteView {
  return {
    provider,
    targetTier,
    enabled: options.enabled !== false,
    resolved:
      model === null
        ? null
        : {
            model,
            targetEnabled: options.targetEnabled !== false,
            hostsWebSearch: options.hostsWebSearch !== false,
            contextWindow: options.contextWindow === undefined ? null : options.contextWindow
          }
  }
}

// Lists by scenario and lane; the ones not named are empty.
export type RoutesSpec<T> = Partial<Record<RoutingScenario, Partial<Record<RoutingLane, T[]>>>>

function fill<T>(spec: RoutesSpec<T>): Record<RoutingScenario, Record<RoutingLane, T[]>> {
  const lanes = (scenario: RoutingScenario): Record<RoutingLane, T[]> => {
    const listed = spec[scenario]
    const of = (lane: RoutingLane): T[] => {
      const list = listed === undefined ? undefined : listed[lane]
      return list === undefined ? [] : list
    }
    return { agent: of('agent'), subagent: of('subagent') }
  }
  return { default: lanes('default'), think: lanes('think'), longContext: lanes('longContext') }
}

// Every knob at the schema's default, so a test names only what it is about.
export const DEFAULT_CONSTRAINTS: RoutingConstraints = {
  exhaustedBehavior: '429',
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5,
  longContextThreshold: null,
  previousLongContextThreshold: null,
  longContextTunedAt: null,
  autoTuneLongContext: true
}

export function mapWith(
  routes: RoutesSpec<TierRouteView>,
  constraints: Partial<RoutingConstraints> = {},
  key = 'live'
): TierProfileView {
  const views: ScenarioRouteViews = fill(routes)
  const merged = { ...DEFAULT_CONSTRAINTS, ...constraints }
  return {
    key,
    routes: views,
    constraints: merged,
    // What `loadTierProfileView` serves, computed the same way, so a
    // fixture cannot disagree with the database read about the threshold.
    longContextThreshold: effectiveLongContextThreshold(
      merged.longContextThreshold,
      longContextBase(defaultAgentWindowOf(views))
    )
  }
}

export function profileWith(routes: RoutesSpec<TierRoute>, constraints: Partial<RoutingConstraints> = {}): TierProfile {
  return { routes: fill(routes), constraints: { ...DEFAULT_CONSTRAINTS, ...constraints } }
}

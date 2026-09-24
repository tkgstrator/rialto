/**
 * Tier maps for tests that exercise the router without a database.
 *
 * `route('claude-code', 'sonnet', 'claude-sonnet-5')` is a route to the
 * provider's sonnet alias, resolved to that model; a null model is an
 * unset alias. Tiers not named stay empty, which is the shape a partially
 * configured install has. Seed with `__setTierProfilesForTests`.
 */

import type { ModelTier, RouteTier } from '../../src/schemas/domain/tier-route'
import type { TierProfileView, TierRouteView } from '../../src/services/tier-route-service'

interface RouteOptions {
  enabled?: boolean
  targetEnabled?: boolean
  hostsWebSearch?: boolean
  contextWindow?: number | null
}

export function route(
  provider: string,
  targetTier: ModelTier,
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

export function mapWith(
  routes: Partial<Record<RouteTier, TierRouteView[]>>,
  constraints: Partial<TierProfileView['constraints']> = {},
  key = 'live'
): TierProfileView {
  const of = (tier: RouteTier): TierRouteView[] => {
    const list = routes[tier]
    return list === undefined ? [] : list
  }
  return {
    key,
    routes: { fable: of('fable'), opus: of('opus'), sonnet: of('sonnet'), haiku: of('haiku'), other: of('other') },
    constraints: {
      exhaustedBehavior: '429',
      quotaSkipPct: 100,
      errorRateSkipPct: 0.5,
      minHealthSamples: 5,
      ...constraints
    }
  }
}

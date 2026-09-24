/**
 * Shapes the Routing screen holds in memory.
 *
 * The wire types live in lib/api-types.ts. What is declared here is the
 * editor's own vocabulary: the draft it edits, and the two readings each
 * route row derives from the loaded profile and the scheduler snapshot.
 */

import type { ModelTier, RouteTier, TierProfileWriteWire, TierRouteResolutionWire, TierRouteWire } from '@/lib/api'

export type { ModelTier, RouteTier }

/** The tiers a route can name on a provider — every requested tier but "other". */
export const MODEL_TIERS: readonly ModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']

/**
 * The profile as the editor holds it: exactly what one PUT writes.
 *
 * Routes carry no resolution. Which model a route reaches is the
 * provider's alias, not something this screen edits, so it is looked up
 * beside the draft (`resolveRoute`) rather than copied into it — a copy
 * would have to be kept in step with every add, move and remove.
 */
export type TierDraft = TierProfileWriteWire
export type DraftRoute = TierRouteWire

/**
 * What a row's "Resolves to" cell can say.
 *
 * `pending` is a route added during this edit whose provider · tier the
 * loaded profile never resolved: the server resolves it on Save. Until
 * then the provider's alias list can still name the model, which is
 * shown, but whether that model is switched on or can run web search is
 * the server's call, so the row claims neither.
 */
export type RouteResolution =
  | { kind: 'resolved'; resolution: TierRouteResolutionWire }
  | { kind: 'unset' }
  | { kind: 'pending'; model: string | null }

/**
 * One reading per route, in the order a reader asks: can it take traffic,
 * how close is it to not being able to, and when does that change.
 */
export type RouteState =
  | { kind: 'ok' }
  | { kind: 'used'; pct: number }
  | { kind: 'exhausted'; until: string | null }
  | { kind: 'unset' }
  | { kind: 'off' }
  | { kind: 'pending' }

/** One routable "provider,model" the operator has left enabled — the passthrough list. */
export interface EnabledTarget {
  target: string
  provider: string
  model: string
}

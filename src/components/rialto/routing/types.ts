/**
 * Shapes the Routing screen holds in memory.
 *
 * The wire types live in lib/api-types.ts. What is declared here is the
 * editor's own vocabulary: the draft it edits and the address of one cell
 * of the scenario table.
 */

import type { ModelTier, RoutingLane, RoutingScenario, ScenarioRoutesWire, TierRouteWire } from '@/lib/api'

export type { ModelTier, RoutingLane, RoutingScenario }

/** One line of a cell: a provider, a tier on it, and whether it is switched on. */
export type Combination = TierRouteWire

/**
 * Every cell of the profile, as one PUT writes it.
 *
 * Only the routes. The constraints ride along unchanged from the loaded
 * profile on Save — nothing on this screen edits them, and the Long
 * context tuner's state lives there — so keeping them out of the draft
 * means an edit can never be "dirty" because of them.
 */
export type ScenarioDraft = ScenarioRoutesWire<Combination>

/** One cell of the table: a scenario row and a lane column. */
export interface CellAddress {
  scenario: RoutingScenario
  lane: RoutingLane
}

/** One routable "provider,model" the operator has left enabled — the passthrough list. */
export interface EnabledTarget {
  target: string
  provider: string
  model: string
}

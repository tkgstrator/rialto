/**
 * The words the table and its dialog use for a scenario and a lane.
 *
 * One table for both: the dialog's title names the cell it edits, and a
 * second copy of these maps is how the title and the row it came from
 * would come to disagree.
 */
import type { RoutingLane, RoutingScenario } from './types'

export const SCENARIO_LABEL_KEYS: Record<RoutingScenario, string> = {
  default: 'routing.scenarios.scenarioDefault',
  think: 'routing.scenarios.scenarioThink',
  longContext: 'routing.scenarios.scenarioLongContext'
}

export const LANE_LABEL_KEYS: Record<RoutingLane, string> = {
  agent: 'routing.common.laneAgent',
  subagent: 'routing.common.laneSubagent'
}

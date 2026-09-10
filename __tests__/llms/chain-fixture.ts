/**
 * Chain profiles for tests that exercise the router without a database.
 *
 * A lane is named `<scenario>.<kind>` and holds targets most-preferred
 * first. Plain strings become enabled entries; an explicit entry can
 * carry `enabled` / `targetEnabled` for the gating cases. Everything not
 * named stays empty, which is the shape a partially configured install
 * has.
 */

import type { RouterPreferenceEntry, RouterPreferenceProfile } from '../../src/schemas/domain/preference'

export type LaneEntry = string | RouterPreferenceEntry

export const entry = (target: string, enabled = true, targetEnabled?: boolean): RouterPreferenceEntry => ({
  priority: 1,
  target,
  enabled,
  ...(targetEnabled === undefined ? {} : { targetEnabled })
})

const toEntries = (lane: LaneEntry[] | undefined): RouterPreferenceEntry[] => {
  if (lane === undefined) return []
  return lane.map((item, idx) => ({ ...(typeof item === 'string' ? entry(item) : item), priority: idx + 1 }))
}

export function profileWith(
  lanes: Partial<Record<string, LaneEntry[]>>,
  constraints: Record<string, unknown> | null = null
): RouterPreferenceProfile {
  const pair = (scenario: string) => ({
    agent: toEntries(lanes[`${scenario}.agent`]),
    subagent: toEntries(lanes[`${scenario}.subagent`])
  })
  return {
    entriesByScenario: {
      default: pair('default'),
      think: pair('think'),
      longContext: pair('longContext'),
      webSearch: pair('webSearch'),
      image: pair('image')
    },
    constraints
  }
}

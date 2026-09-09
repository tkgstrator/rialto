/**
 * Wire types the Routing screens read.
 *
 * `RouterPreferenceEntryWire` in lib/api.ts predates `resolvedTier`, which
 * the server populates on every read (router-preference-service.ts) and the
 * chain table needs for its Tier column. Declared here rather than widened
 * there because lib/api.ts is owned elsewhere during the migration.
 */

import type { ModelTier } from '@/shared/data'

export const SCENARIOS = ['default', 'think', 'longContext', 'webSearch', 'image'] as const
export type ScenarioKey = (typeof SCENARIOS)[number]

export const LANES = ['agent', 'subagent'] as const
export type Lane = (typeof LANES)[number]

// One definition, in shared, because the built-in presets are written in
// tiers and are bundled for the browser from there. A second copy here
// would be free to drift from the one the presets are validated against.
export type Tier = ModelTier

export interface PreferenceEntry {
  priority: number
  target: string
  enabled: boolean
  /** Server-computed: Model.manualTier, else inferred from the name. */
  resolvedTier?: Tier | null
}

export type PreferenceByLane = Record<Lane, PreferenceEntry[]>
export type PreferenceByScenario = Record<ScenarioKey, PreferenceByLane>

export interface PreferenceProfile {
  entriesByScenario: PreferenceByScenario
  /** Opaque JSONB blob — read for the constraints rail, written back verbatim. */
  constraints: Record<string, unknown> | null
}

export interface PreferenceApplyResponse {
  success: boolean
  warnings: string[]
}

/** One row of GET /api/router-preferences/profiles. */
export interface ProfileSummary {
  key: string
  entryCount: number
  updatedAt: string | null
  /**
   * `passthrough` is a reserved key meaning "skip routing", not a stored
   * chain. Flagged by the server so a picker can tell it apart without
   * matching on the string — and so an empty chain and a deliberate
   * mode are never labelled the same way.
   */
  kind: 'chain' | 'passthrough'
}

/** How a target is behaving right now, per the last scheduler tick. */

/** One routable "provider,model" the operator has left enabled. */
export interface EnabledTarget {
  target: string
  provider: string
  model: string
  tier: Tier | null
}

/** An EnabledTarget that also says whether it is switched on. */
export interface ReachableTarget extends EnabledTarget {
  enabled: boolean
}

/**
 * Push a router snapshot onto the live routing.
 *
 * "Live routing" is two stores, not one, and a preset has to reach both:
 *
 * - `RouterPreferenceEntry`, the ordered chain per scenario and lane.
 *   This is what the Chain screen renders and what the quota-aware
 *   selector walks, which since v2.76 is the default selector.
 * - `Router` on the config envelope (RouterSlot + the rules), which the
 *   scenario selector still reads and which carries `LiveRoutingName`.
 *
 * It used to write only the second. Applying a preset therefore reported
 * success, moved nothing the operator could see, and changed nothing the
 * request path consulted on a default install — the chain simply stayed
 * where it was. Both writes now happen, chain first: it is the one the
 * screen is showing, so a failure there must not leave the envelope
 * claiming a preset that never landed.
 *
 * Returns a discriminated result rather than throwing so callers can
 * keep their handlers flat — no nested try/catch or `?.` on `res.success`.
 */

import type {
  PreferenceApplyResponse,
  PreferenceByScenario,
  PreferenceProfile
} from '@/components/rialto/routing/types'
import { LANES, SCENARIOS } from '@/components/rialto/routing/types'
import { api } from '@/lib/api'
import type { RouterConfig } from '@/schemas/domain/router'
import type { Config } from '@/types'

export type ApplyResult =
  | {
      ok: true
      updatedConfig: Config
      /** The chain that was written, so the caller can show it without a refetch. */
      profile: PreferenceProfile | null
      /** Targets the server dropped (a preset may name a model this install no longer has). */
      warnings: readonly string[]
    }
  | { ok: false; message: string }

/** A route's chain, primary first. Empty slots drop out rather than becoming entries. */
const laneChain = (route: RouterConfig['default']['agent']): string[] => {
  const targets = [route.primary, ...route.fallbacks]
  return targets.filter((target): target is string => target !== null && target.length > 0)
}

/**
 * A RouterConfig as preference entries.
 *
 * Everything lands `enabled: true`: a preset is a statement about which
 * targets to use, and a disabled entry would be a target the operator
 * has to go switch on before the preset they just applied does anything.
 */
export function preferencesFromRouter(draft: RouterConfig): PreferenceByScenario {
  const byScenario = {} as PreferenceByScenario
  for (const scenario of SCENARIOS) {
    const lanes = { agent: [], subagent: [] } as PreferenceByScenario[typeof scenario]
    for (const lane of LANES) {
      lanes[lane] = laneChain(draft[scenario][lane]).map((target, index) => ({
        priority: index + 1,
        target,
        enabled: true
      }))
    }
    byScenario[scenario] = lanes
  }
  return byScenario
}

// `presetName` is folded into the envelope's LiveRoutingName so the Live
// card's display label reads as "Work" instead of the generic "Live" — a
// lightweight source-of-truth signal without the schema surface of an
// explicit activePresetId column. Callers that don't want the name to
// change (e.g. renaming Live directly) should not go through this helper.
export async function applyPresetToLive(
  liveConfig: Config,
  draft: RouterConfig,
  presetName: string,
  chain: { profileKey: string | null; constraints: Record<string, unknown> | null }
): Promise<ApplyResult> {
  const profile: PreferenceProfile | null =
    chain.profileKey === null
      ? null
      : { entriesByScenario: preferencesFromRouter(draft), constraints: chain.constraints }

  const warnings: string[] = []
  if (profile !== null && chain.profileKey !== null) {
    try {
      const applied = await api.put<PreferenceApplyResponse>(
        `/router-preferences?profile=${encodeURIComponent(chain.profileKey)}`,
        profile
      )
      if (!applied.success) {
        return { ok: false, message: applied.warnings.join(' ') }
      }
      warnings.push(...applied.warnings)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  const updated = { ...liveConfig, Router: draft, LiveRoutingName: presetName }
  try {
    const res = await api.updateConfig(updated)
    if (typeof res === 'object' && res !== null && 'success' in res && res.success === false) {
      const message = 'message' in res && typeof res.message === 'string' ? res.message : 'update failed'
      return { ok: false, message }
    }
    return { ok: true, updatedConfig: updated, profile, warnings }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

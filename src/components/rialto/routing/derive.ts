/**
 * Pure derivations shared by the Routing screens.
 *
 * The chain table, the map and the passthrough list all have to answer
 * "what state is this target in" and "what tier is this model"; keeping
 * the answers here stops three screens from drifting into three sets of
 * thresholds.
 */
import type { RoutingSchedulerStateResponse, RoutingSchedulerWeightEntry } from '@/lib/api'
import type { Provider } from '@/schemas/domain/provider'
import type { EnabledTarget, PreferenceByScenario, Tier } from './types'
import { SCENARIOS } from './types'

/** Split a "provider,model" target. A malformed row keeps the raw string as its model. */
export function splitTarget(target: string): { provider: string; model: string } {
  const comma = target.indexOf(',')
  if (comma <= 0) return { provider: '', model: target }
  return { provider: target.slice(0, comma), model: target.slice(comma + 1) }
}

/**
 * Name-based tier inference. Mirrors `inferTier` in
 * services/router-preference-service.ts — the server resolves the tier for
 * preference entries, but the passthrough list and the model picker draw
 * from /api/config, which carries only the manual overrides.
 */
export function inferTier(modelName: string): Tier | null {
  const lower = modelName.toLowerCase()
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return null
}

/**
 * Every "provider,model" the operator has left routable: providers switched
 * off and models in `transformer._disabledModels` drop out, matching the
 * gate ModelsDashboard and TierEditor apply.
 */
export function enabledTargets(providers: readonly Provider[]): EnabledTarget[] {
  const out: EnabledTarget[] = []
  for (const provider of providers) {
    if (provider.enabled === false) continue
    const disabled = new Set(provider.transformer?._disabledModels)
    const manual = provider.modelManualTiers
    for (const model of [...provider.models].sort((a, b) => a.localeCompare(b))) {
      if (disabled.has(model)) continue
      const override = manual === undefined ? undefined : manual[model]
      out.push({
        target: `${provider.name},${model}`,
        provider: provider.name,
        model,
        tier: override === undefined ? inferTier(model) : override
      })
    }
  }
  return out
}

/** Weight snapshot keyed by target, so a row can look up its own live numbers. */
export function weightIndex(state: RoutingSchedulerStateResponse | null): Map<string, RoutingSchedulerWeightEntry> {
  const out = new Map<string, RoutingSchedulerWeightEntry>()
  if (state === null) return out
  for (const entry of state.weights) out.set(entry.target, entry)
  return out
}

/**
 * How a chain row names its target.
 *
 * "provider,model" repeats the provider down the whole column — in a
 * lane that is usually one subscription, every row starts with the same
 * eleven characters before it says anything. The model name is the part
 * that differs, and the provider is one click away on the row itself.
 *
 * The exception is the case that makes the short form a lie: the same
 * model reached through two providers (a Claude subscription and an
 * api_key Anthropic account, say), which is an ordinary failover chain
 * and would otherwise render as two identical rows. Those keep the full
 * pair — both of them, so the column does not silently use two
 * conventions for what looks like the same thing.
 */
export function targetLabels(targets: readonly string[]): Map<string, string> {
  const seen = new Map<string, number>()
  for (const target of targets) {
    const { model } = splitTarget(target)
    const count = seen.get(model)
    seen.set(model, count === undefined ? 1 : count + 1)
  }
  const out = new Map<string, string>()
  for (const target of targets) {
    const { model } = splitTarget(target)
    out.set(target, seen.get(model) === 1 ? model : target)
  }
  return out
}

export interface ShareRow {
  target: string
  enabled: boolean
  weight: number | undefined
}

/**
 * Each enabled target's slice of the lane's published weight, as whole
 * percents that add up to exactly 100.
 *
 * Apportioned by largest remainder rather than rounded independently:
 * three equal targets round to 33/33/33 and the column visibly fails to
 * add up, which is the entire thing this is here to avoid.
 *
 * A row that is switched off, or that the scheduler has not scored, maps
 * to null — it is not competing for the lane, so it takes no slice and
 * shows a dash rather than a 0% that would read as "came last".
 */
export function chainShares(rows: readonly ShareRow[]): Map<string, number | null> {
  const out = new Map<string, number | null>()
  for (const row of rows) out.set(row.target, row.enabled && row.weight !== undefined ? 0 : null)

  const eligible = rows.filter((row) => row.enabled && row.weight !== undefined && row.weight > 0)
  const total = eligible.reduce((sum, row) => sum + (row.weight === undefined ? 0 : row.weight), 0)
  if (total <= 0) return out

  const exact = eligible.map((row) => {
    const value = ((row.weight === undefined ? 0 : row.weight) / total) * 100
    const floor = Math.floor(value)
    return { target: row.target, floor, remainder: value - floor }
  })
  const assigned = exact.reduce((sum, entry) => sum + entry.floor, 0)
  // Ties broken by the order the chain is already in, which is the
  // operator's own priority order — the only tiebreak that is not
  // arbitrary from where they are sitting.
  const ranked = [...exact].sort((a, b) => b.remainder - a.remainder)
  for (const [index, entry] of ranked.entries()) {
    out.set(entry.target, entry.floor + (index < 100 - assigned ? 1 : 0))
  }
  return out
}

// `hasBudgetReading` and `targetState` lived here, with STATE_TONE and
// STATE_LABEL_KEYS below them. They classified a target as ready /
// throttled / exhausted / unknown for a State column that neither table
// carries any more: the chain shows Share, which already says an
// exhausted target is at 0% and a disabled one at a dash, and a
// passthrough surface is never scored at all, so its column read
// `unknown` on every row of every install.

// `schedulerRuns`, `activeSelector` and `MODE_FOR_SELECTOR` lived here.
// They existed to answer "which of the two selectors is live", and to
// warn that the scheduler publishes nothing under the other one. The
// chain is the only selector now, so the scheduler always runs and the
// question has one answer.

/**
 * The scheduler ran and had nothing to score.
 *
 * Turning the mode on is only half of what a live reading needs: the
 * tick builds its weights entirely from `RouterPreferenceEntry` rows, so
 * on an install with no chain configured it publishes an empty snapshot
 * and the Share column stays empty. Saying "set ROUTER_MODE to
 * quota-aware to see live numbers" and leaving it there sends an
 * operator to flip a switch that changes nothing on their screen.
 *
 * Gated on having ticked at least once. A cold boot in quota-aware mode
 * also has no weights yet, and that one resolves on its own.
 */
export function schedulerScoredNothing(state: RoutingSchedulerStateResponse | null): boolean {
  if (state === null) return false
  return state.tickAt !== null && state.weights.length === 0
}

/**
 * The scheduler is armed but has not produced a snapshot yet.
 *
 * The other way the Share column comes up empty, and the one that had no
 * note. `schedulerScoredNothing` deliberately waits for a first tick, so
 * between boot and that tick (the interval defaults to five minutes)
 * every row reads a dash with nothing on screen saying why, which is
 * indistinguishable from a lane nobody has configured.
 */
export function schedulerNotTickedYet(state: RoutingSchedulerStateResponse | null): boolean {
  if (state === null) return false
  return state.tickAt === null
}

/** Empty profile shape — every scenario and lane present, so tabs never branch on "missing". */
export function emptyByScenario(): PreferenceByScenario {
  return {
    default: { agent: [], subagent: [] },
    think: { agent: [], subagent: [] },
    longContext: { agent: [], subagent: [] },
    webSearch: { agent: [], subagent: [] },
    image: { agent: [], subagent: [] }
  }
}

/** Distinct targets referenced anywhere in the profile, in first-seen order. */
export function profileTargets(byScenario: PreferenceByScenario): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const scenario of SCENARIOS) {
    for (const lane of ['agent', 'subagent'] as const) {
      for (const entry of byScenario[scenario][lane]) {
        if (seen.has(entry.target)) continue
        seen.add(entry.target)
        out.push(entry.target)
      }
    }
  }
  return out
}

/**
 * Total entries across every scenario and lane.
 *
 * Zero means the profile has never been configured, which is not the same
 * as a chain that routes nowhere: the request passes through with the
 * model the caller asked for. The two need different empty states.
 */
export function profileEntryCount(byScenario: PreferenceByScenario): number {
  return SCENARIOS.reduce(
    (total, scenario) => total + byScenario[scenario].agent.length + byScenario[scenario].subagent.length,
    0
  )
}

/** Renumber a chain so `priority` matches list position after a move or a delete. */
export function renumber<T extends { priority: number }>(entries: readonly T[]): T[] {
  return entries.map((entry, index) => ({ ...entry, priority: index + 1 }))
}

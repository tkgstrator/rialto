/**
 * Pure derivations for the Routing screen.
 *
 * Every edit the scenario table makes — add, change, remove, move, switch
 * — is a function from one draft to the next here, without React, so each
 * can be pinned on its own. So is what the add dialog offers, and how the
 * Long context threshold reads.
 */
import type { TierAliasWire, TierProfileViewWire } from '@/lib/api'
import { MODEL_TIER_ORDER, ROUTING_LANE_ORDER, ROUTING_SCENARIO_ORDER } from '@/lib/api-types'
import type { Provider } from '@/schemas/domain/provider'
import type { CellAddress, Combination, EnabledTarget, ModelTier, ScenarioDraft } from './types'

/**
 * Every "provider,model" the operator has left routable: providers switched
 * off and models in `transformer._disabledModels` drop out, matching the
 * gate the Providers screen applies.
 */
export function enabledTargets(providers: readonly Provider[]): EnabledTarget[] {
  const out: EnabledTarget[] = []
  for (const provider of providers) {
    if (provider.enabled === false) continue
    const disabled = new Set(provider.transformer?._disabledModels)
    for (const model of [...provider.models].sort((a, b) => a.localeCompare(b))) {
      if (disabled.has(model)) continue
      out.push({ target: `${provider.name},${model}`, provider: provider.name, model })
    }
  }
  return out
}

/**
 * The providers a new combination may name.
 *
 * A switched-off provider is left out rather than offered: a line naming it
 * would be kept but never taken, and the add dialog is where that mistake
 * is cheapest to prevent.
 */
export function enabledProviderNames(providers: readonly Provider[]): string[] {
  return providers.filter((provider) => provider.enabled !== false).map((provider) => provider.name)
}

/**
 * One key per provider · tier, unique within a cell because a cell never
 * holds the same combination twice.
 *
 * Tier first: a tier name never contains a colon, so the key cannot be
 * ambiguous whatever the provider happens to be called.
 */
export const combinationKey = (provider: string, tier: ModelTier): string => `${tier}:${provider}`

export function emptyDraft(): ScenarioDraft {
  return {
    default: { agent: [], subagent: [] },
    think: { agent: [], subagent: [] },
    longContext: { agent: [], subagent: [] }
  }
}

/**
 * The write-shaped copy of a loaded profile's routes.
 *
 * Built field by field in a fixed order rather than spread from the view,
 * so the draft and its baseline serialise identically and `draftDiffers`
 * can compare them as strings — and so the resolution the view carries
 * beside each route never reaches the PUT.
 */
export function draftOf(view: TierProfileViewWire): ScenarioDraft {
  const draft = emptyDraft()
  for (const scenario of ROUTING_SCENARIO_ORDER) {
    for (const lane of ROUTING_LANE_ORDER) {
      draft[scenario][lane] = view.routes[scenario][lane].map((route) => ({
        provider: route.provider,
        targetTier: route.targetTier,
        enabled: route.enabled
      }))
    }
  }
  return draft
}

/** Whether an edit has changed anything one PUT would write. */
export function draftDiffers(a: ScenarioDraft, b: ScenarioDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b)
}

export const cellOf = (draft: ScenarioDraft, at: CellAddress): Combination[] => draft[at.scenario][at.lane]

/** The draft with one cell replaced; every other cell is the same object as before. */
function withCell(draft: ScenarioDraft, at: CellAddress, fn: (prev: Combination[]) => Combination[]): ScenarioDraft {
  return { ...draft, [at.scenario]: { ...draft[at.scenario], [at.lane]: fn(cellOf(draft, at)) } }
}

const inRange = (routes: readonly Combination[], index: number): boolean => index >= 0 && index < routes.length

/**
 * Whether the cell already holds this provider · tier on a line other than
 * `except` — the duplicate the dialog refuses. `except` is the line being
 * changed, which may of course keep what it already is.
 */
export function hasCombination(
  routes: readonly Combination[],
  provider: string,
  tier: ModelTier,
  except: number | null = null
): boolean {
  return routes.some((route, i) => i !== except && route.provider === provider && route.targetTier === tier)
}

/**
 * Append a combination to a cell, switched on.
 *
 * A duplicate leaves the draft as it was. The dialog already refuses one;
 * checked again here because the draft is what gets written, and the
 * server would drop the second copy with a warning the operator never
 * asked for.
 */
export function addCombination(
  draft: ScenarioDraft,
  at: CellAddress,
  provider: string,
  tier: ModelTier
): ScenarioDraft {
  if (hasCombination(cellOf(draft, at), provider, tier)) return draft
  return withCell(draft, at, (prev) => [...prev, { provider, targetTier: tier, enabled: true }])
}

/**
 * Point one line at another provider · tier. It keeps its place and its
 * switch: changing what a line names is not a reason to turn it back on.
 */
export function changeCombination(
  draft: ScenarioDraft,
  at: CellAddress,
  index: number,
  provider: string,
  tier: ModelTier
): ScenarioDraft {
  const routes = cellOf(draft, at)
  if (!inRange(routes, index) || hasCombination(routes, provider, tier, index)) return draft
  return withCell(draft, at, (prev) =>
    prev.map((route, i) => (i === index ? { ...route, provider, targetTier: tier } : route))
  )
}

export function removeCombination(draft: ScenarioDraft, at: CellAddress, index: number): ScenarioDraft {
  if (!inRange(cellOf(draft, at), index)) return draft
  return withCell(draft, at, (prev) => prev.filter((_, i) => i !== index))
}

export function toggleCombination(
  draft: ScenarioDraft,
  at: CellAddress,
  index: number,
  enabled: boolean
): ScenarioDraft {
  if (!inRange(cellOf(draft, at), index)) return draft
  return withCell(draft, at, (prev) => prev.map((route, i) => (i === index ? { ...route, enabled } : route)))
}

/**
 * Move one line within its cell. A cell is the only scope a move has:
 * carrying a line to another scenario or lane changes what it means, not
 * its order, so there is no such move. An out-of-range end leaves the
 * draft as it was.
 */
export function moveCombination(draft: ScenarioDraft, at: CellAddress, from: number, to: number): ScenarioDraft {
  const routes = cellOf(draft, at)
  if (from === to || !inRange(routes, from) || !inRange(routes, to)) return draft
  return withCell(draft, at, (prev) => {
    const next = [...prev]
    const [pulled] = next.splice(from, 1)
    next.splice(to, 0, pulled)
    return next
  })
}

/**
 * Why a tier can or cannot be picked in the dialog's second step.
 *
 * `unset`: the provider has no model for it (no alias row, or one naming
 * no model), so a line through it would reach nothing. `taken`: the cell
 * already holds it.
 */
export type TierAvailability = 'available' | 'unset' | 'taken'

export interface TierOption {
  tier: ModelTier
  availability: TierAvailability
}

/**
 * The four tiers of one provider as the dialog offers them for one cell.
 *
 * A null alias list is one that failed to load. Nothing is marked unset
 * then: claiming an alias is missing on no evidence would block a valid
 * choice, whereas letting an unset one through only costs the warning the
 * server answers Save with.
 */
export function tierOptions(
  provider: string,
  aliases: readonly TierAliasWire[] | null,
  routes: readonly Combination[],
  except: number | null
): TierOption[] {
  return MODEL_TIER_ORDER.map((tier): TierOption => {
    if (hasCombination(routes, provider, tier, except)) return { tier, availability: 'taken' }
    const set =
      aliases === null ||
      aliases.some((alias) => alias.provider === provider && alias.tier === tier && alias.model !== null)
    return { tier, availability: set ? 'available' : 'unset' }
  })
}

/** At most `digits` decimals, trailing zeros dropped: 1.20 → "1.2", 1.00 → "1". */
const trimmed = (value: number, digits: number): string => String(Number(value.toFixed(digits)))

/**
 * A token count as the Long context row states it: `700k`, `128k`,
 * `35.8k`, `1M`, `1.2M`.
 *
 * Whole thousands from 100k up. The threshold is a round number when it
 * is automatic, and the tuner moves it in 20% steps, so a decimal there
 * would be precision nobody set.
 */
export function formatThreshold(tokens: number): string {
  if (tokens >= 999_500) return `${trimmed(tokens / 1_000_000, 2)}M`
  if (tokens >= 100_000) return `${Math.round(tokens / 1_000)}k`
  if (tokens >= 1_000) return `${trimmed(tokens / 1_000, 1)}k`
  return String(tokens)
}

import type { CatalogEntry, CatalogModel } from '@/schemas/api/catalog'
import { apiStyleOverrideOf, disabledModelsOf, effortOf, listedModelsOf, testStatusOf } from './derive'
import { type AliasMap, tiersServedBy } from './tier-aliases'
import type { ApiStyle, Provider, ReasoningEffort, TestStatus, Tier } from './types'

/**
 * Context window, in the mock's `400k` / `1M` shorthand.
 *
 * `lib/models/format-context.ts` renders an uppercase `200K`; the Rialto
 * tables use lowercase so the column reads as a magnitude rather than as
 * a unit symbol.
 */
export function fmtContext(n: number | undefined): string {
  if (n === undefined || n <= 0) return '—'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : parseFloat(m.toFixed(2))}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export interface ModelRow {
  name: string
  /**
   * The tiers this model is the alias for on its provider, in strip
   * order. Routing reaches a model only through an alias, so empty means
   * nothing routed lands here however the model is switched.
   */
  aliasTiers: Tier[]
  /** Listed as a new candidate for some tier: found after that alias was last set. */
  isNew: boolean
  /** Model.reasoningEffort. Null means "send nothing, let the vendor pick". */
  effort: ReasoningEffort | null
  contextWindow: number | undefined
  inputPer1M: number | null
  cachedInputPer1M: number | null
  outputPer1M: number | null
  imagePricing: CatalogModel['imagePricing']
  apiStyleOverride: ApiStyle | null
  test: TestStatus
  enabled: boolean
  legacy: boolean
}

const catalogModelIndex = (entry: CatalogEntry | undefined): Map<string, CatalogModel> =>
  new Map(entry === undefined ? [] : entry.models.map((m) => [m.name, m]))

/**
 * One row per listed model.
 *
 * Prices come from the provider row (DB-held, scraped or backfilled) with
 * one exception: the cached-input leg is not mirrored onto Provider, so it
 * is read from the vendor catalog entry. Absent on both sides means the
 * vendor publishes no price, which the table shows as a dash.
 *
 * `aliases` and `fresh` are the provider's tier aliases and its new
 * candidates. The add-provider wizard reads neither and passes nothing.
 */
export function buildModelRows(
  p: Provider,
  catalogEntry: CatalogEntry | undefined,
  aliases: AliasMap = {},
  fresh: ReadonlySet<string> = new Set()
): ModelRow[] {
  const off = new Set(disabledModelsOf(p))
  const ctx = p.modelContextWindows === undefined ? {} : p.modelContextWindows
  const prices = p.modelPrices === undefined ? {} : p.modelPrices
  const catalogModels = catalogModelIndex(catalogEntry)
  return listedModelsOf(p).map((name) => {
    const price = prices[name]
    const fromCatalog = catalogModels.get(name)
    return {
      name,
      aliasTiers: tiersServedBy(aliases, name),
      isNew: fresh.has(name),
      effort: effortOf(p, name),
      contextWindow: ctx[name],
      inputPer1M: price === undefined ? null : price.inputPer1M,
      cachedInputPer1M: fromCatalog === undefined ? null : fromCatalog.cachedInputPer1M,
      outputPer1M: price === undefined ? null : price.outputPer1M,
      imagePricing: fromCatalog === undefined ? null : fromCatalog.imagePricing,
      apiStyleOverride: apiStyleOverrideOf(p, name),
      test: testStatusOf(p, name),
      enabled: !off.has(name),
      legacy: fromCatalog === undefined ? false : fromCatalog.legacy
    }
  })
}

/**
 * Which slice of a long model list to show. The default is 'enabled' —
 * on an 18-model vendor the five that are switched on are what the
 * provider actually serves, and the other thirteen are decisions the
 * operator has already made. 'priced' widens to what could be switched
 * on; 'all' is the only one that reveals legacy rows.
 */
export type ShowMode = 'priced' | 'enabled' | 'all'

/**
 * A legacy row worth folding away.
 *
 * Legacy models are still priced, so "Enabled + priced" kept every one of
 * them — rows of vendor history above the models anyone actually routes
 * to, and a decision the operator already made.
 *
 * Unless one is switched on. A legacy model that is enabled is a live
 * routing target, and a list that hides a live target cannot be trusted
 * to say what this provider serves.
 */
export const hidesAsLegacy = (row: ModelRow): boolean => row.legacy && !row.enabled

/** The api_key side's Show control. Legacy rows survive only under "all". */
export const passesShow = (row: ModelRow, mode: ShowMode): boolean => {
  if (mode === 'all') return true
  if (hidesAsLegacy(row)) return false
  if (mode === 'enabled') return row.enabled
  return row.enabled || row.inputPer1M !== null || row.outputPer1M !== null
}

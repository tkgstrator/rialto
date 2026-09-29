import type { CatalogEntry, CatalogModel } from '@/schemas/api/catalog'
import { apiStyleOverrideOf, disabledModelsOf, effortOf, listedModelsOf, testStatusOf } from './derive'
import type { TierView } from './tier-aliases'
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
   * The tiers this model belongs to on its provider, in strip order: the
   * one its name says, and any manual tier aliased to it. `routed` is
   * whether the tier reaches this model today. Routing reaches a model
   * only through a tier, so no routed entry means nothing routed lands
   * here however the model is switched.
   */
  tiers: Array<{ tier: Tier; routed: boolean }>
  /** Newer than the model its tier routes to, and switched off: switching it on moves the tier. */
  newer: boolean
  /** Model.reasoningEffort. Null means "send nothing, let the vendor pick". */
  effort: ReasoningEffort | null
  /**
   * The effort levels this model's own subscription list reported,
   * recorded once (Provider.modelSupportedEfforts). Null until recorded,
   * and on api_key providers, which record nothing.
   */
  supportedEfforts: readonly ReasoningEffort[] | null
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
 * `views` are the provider's tiers (`tierViewsOf`). The add-provider
 * wizard shows no tier column and passes nothing.
 */
export function buildModelRows(
  p: Provider,
  catalogEntry: CatalogEntry | undefined,
  views: readonly TierView[] = []
): ModelRow[] {
  const off = new Set(disabledModelsOf(p))
  const ctx = p.modelContextWindows === undefined ? {} : p.modelContextWindows
  const recordedEfforts = p.modelSupportedEfforts === undefined ? {} : p.modelSupportedEfforts
  const prices = p.modelPrices === undefined ? {} : p.modelPrices
  const catalogModels = catalogModelIndex(catalogEntry)
  return listedModelsOf(p).map((name) => {
    const price = prices[name]
    const fromCatalog = catalogModels.get(name)
    return {
      name,
      tiers: views.flatMap((v) =>
        v.mode === 'derived'
          ? v.named.includes(name)
            ? [{ tier: v.tier, routed: v.model === name }]
            : []
          : v.model === name
            ? [{ tier: v.tier, routed: true }]
            : []
      ),
      newer: views.some((v) => v.newer.includes(name)),
      effort: effortOf(p, name),
      supportedEfforts: recordedEfforts[name] === undefined ? null : recordedEfforts[name],
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

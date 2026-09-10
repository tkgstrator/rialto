import type { Provider } from '@/types'
import type { ModelRow, SortKey } from './types'

// Flatten enabled providers' models into one row per (provider, model),
// skipping providers that are disabled or have no usable credential yet
// (a subscription provider needs an active plan; an api_key provider needs
// a non-empty key).
export function buildModelRows(providers: Provider[], planByProvider: Record<string, string | null>): ModelRow[] {
  return providers.flatMap((provider) => {
    if (!provider) return []
    const providerName = provider.name || 'unknown'
    if (provider.enabled === false) return []
    const providerAvailable =
      provider.auth_mode === 'subscription'
        ? Boolean(planByProvider[providerName])
        : (provider.api_key?.trim().length ?? 0) > 0
    if (!providerAvailable) return []
    const models = Array.isArray(provider.models) ? provider.models : []
    const disabledList = Array.isArray(provider.transformer?._disabledModels)
      ? provider.transformer._disabledModels
      : []
    const isSubscription = provider.auth_mode === 'subscription'
    const deprecatedSet = new Set(provider.deprecatedModels ?? [])
    const ctxMap = provider.modelContextWindows ?? {}
    const priceMap = provider.modelPrices ?? {}
    // Deprecated models are dropped from the dashboard entirely — an
    // operator who wants to route to one still can by adding it to a
    // chain in Routing, but the browsing surface stays a short list of
    // things that are currently offered. Prior behaviour surfaced them with a
    // "deprecated" badge, which cluttered the table without adding
    // decision value the operator could act on from this screen.
    return models.flatMap((model) => {
      if (deprecatedSet.has(model)) return []
      const key = `${providerName},${model}`
      const enabled = !disabledList.includes(model)
      // DB-only prices, mirroring how contextWindow is sourced. No static
      // price fallback — a model absent from modelPrices shows "—".
      const price = priceMap[model]
      return [
        {
          provider: providerName,
          model,
          key,
          enabled,
          isSubscription,
          contextWindow: ctxMap[model],
          inputPer1M: price?.inputPer1M,
          outputPer1M: price?.outputPer1M
        }
      ]
    })
  })
}

// Unpriced rows (null or absent) sort last regardless of direction handling
// upstream; Number.POSITIVE_INFINITY is a sort sentinel, not a displayed value.
function priceOf(row: ModelRow, which: 'inputPer1M' | 'outputPer1M'): number {
  const v = row[which]
  return typeof v === 'number' ? v : Number.POSITIVE_INFINITY
}

// No active sort: keep the natural order — providers in config order,
// models in their per-provider order. We used to fall through to an
// alphabetical model tiebreak here, which surfaced "openai
// chatgpt-4o-latest" at the top because 'cha' < 'cla'.
export function sortModelRows(rows: ModelRow[], sortKey: SortKey | null, sortDir: 'asc' | 'desc'): ModelRow[] {
  if (!sortKey) return rows
  const sign = sortDir === 'asc' ? 1 : -1
  const primary = (row: ModelRow) => {
    if (sortKey === 'input') return priceOf(row, 'inputPer1M')
    if (sortKey === 'output') return priceOf(row, 'outputPer1M')
    return row[sortKey]
  }
  // Stable sort on primary only — ties preserve raw (provider-grouped,
  // config-ordered) order, so sorting by Provider doesn't reorder the
  // models inside each group.
  return [...rows].sort((a, b) => {
    const av = primary(a)
    const bv = primary(b)
    if (av < bv) return -1 * sign
    if (av > bv) return 1 * sign
    return 0
  })
}

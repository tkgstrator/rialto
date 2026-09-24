/**
 * One load for everything the Providers screens read.
 *
 * Five endpoints because five things own the answer: the provider rows,
 * the OAuth accounts on them, the vendor catalog (display names, cached
 * prices, legacy flags), the live transformer registry, and the quota
 * collector. Only the provider list is required — the rest degrade to
 * empty so a cold install still renders its providers instead of an error.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { type AccountExtrasIndex, indexAccountExtras, indexQuota, type QuotaIndex } from './derive'
import type {
  CatalogEntry,
  CatalogResponse,
  Provider,
  SubscriptionsResponse,
  SubscriptionWire,
  TransformersResponse,
  TransformerWire
} from './types'

export interface ProvidersData {
  providers: Provider[]
  subscriptions: Map<string, SubscriptionWire>
  catalog: CatalogEntry[]
  transformers: TransformerWire[]
  quota: QuotaIndex
  /** Per account: what it carried at API prices, and its banked resets. */
  accounts: AccountExtrasIndex
  /**
   * Server-side totals, so the subtitle here reports the same numbers the
   * Overview screen does. Null when the summary endpoint was unreachable —
   * the screen then counts what it has.
   */
  counts: { providers: number; enabledModels: number } | null
  /** The instant the quota snapshot describes, for every "resets in" label. */
  now: number
}

const EMPTY_SUBS: SubscriptionsResponse = { subscriptions: [] }
const EMPTY_CATALOG: CatalogResponse = { entries: [] }
const EMPTY_TRANSFORMERS: TransformersResponse = { transformers: [] }

export function useProvidersData() {
  const { t } = useTranslation()
  const [data, setData] = useState<ProvidersData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [providers, subs, catalog, transformers, overview] = await Promise.all([
        api.get<Provider[]>('/providers'),
        api.get<SubscriptionsResponse>('/subscriptions').catch(() => EMPTY_SUBS),
        api.get<CatalogResponse>('/catalog').catch(() => EMPTY_CATALOG),
        api.get<TransformersResponse>('/transformers').catch(() => EMPTY_TRANSFORMERS),
        api.getOverview({ windowHours: 24 }).catch(() => null)
      ])
      setData({
        providers,
        subscriptions: new Map(subs.subscriptions.map((s) => [s.providerName, s])),
        catalog: catalog.entries,
        transformers: transformers.transformers,
        quota: indexQuota(overview === null ? [] : overview.quota),
        accounts: indexAccountExtras(overview === null ? [] : overview.quota),
        counts:
          overview === null ? null : { providers: overview.providerCount, enabledModels: overview.enabledModelCount },
        now: overview === null ? Date.now() : Date.parse(overview.generatedAt)
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('providers.screen.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  return { data, error, loading, reload: load }
}

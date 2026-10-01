/**
 * One load for everything the Providers screens read.
 *
 * Only providers are required. Optional reads retain their last successful
 * values during a background poll rather than blanking a healthy screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { type AccountExtrasIndex, indexAccountExtras, indexQuota, type QuotaIndex } from './derive'
import type {
  CatalogEntry,
  CatalogResponse,
  Provider,
  SubscriptionsResponse,
  SubscriptionWire,
  TierAliasWire,
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
  /** Every provider's four tier aliases and the candidates for each. */
  aliases: TierAliasWire[]
  /** Server-side totals; null when the summary has never been available. */
  counts: { providers: number; enabledModels: number } | null
  /** Current wall clock, not the instant an old quota snapshot was captured. */
  now: number
}

const readProviders = () =>
  Promise.allSettled([
    api.get<Provider[]>('/providers'),
    api.get<SubscriptionsResponse>('/subscriptions'),
    api.get<CatalogResponse>('/catalog'),
    api.get<TransformersResponse>('/transformers'),
    api.getOverview({ windowHours: 24 }),
    api.getTierAliases()
  ])

const keepSuccessful = <T, U>(result: PromiseSettledResult<T>, project: (value: T) => U, previous: U): U =>
  result.status === 'fulfilled' ? project(result.value) : previous

const EMPTY_DATA: ProvidersData = {
  providers: [],
  subscriptions: new Map(),
  catalog: [],
  transformers: [],
  quota: new Map(),
  accounts: new Map(),
  aliases: [],
  counts: null,
  now: 0
}

function mergeRead(previous: ProvidersData | null, read: Awaited<ReturnType<typeof readProviders>>): ProvidersData {
  const known = previous === null ? EMPTY_DATA : previous
  const [providers, subs, catalog, transformers, overview, aliases] = read
  return {
    providers: keepSuccessful(providers, (rows) => rows, known.providers),
    subscriptions: keepSuccessful(
      subs,
      (value) => new Map(value.subscriptions.map((s) => [s.providerName, s])),
      known.subscriptions
    ),
    catalog: keepSuccessful(catalog, (value) => value.entries, known.catalog),
    transformers: keepSuccessful(transformers, (value) => value.transformers, known.transformers),
    quota: keepSuccessful(overview, (value) => indexQuota(value.quota), known.quota),
    accounts: keepSuccessful(overview, (value) => indexAccountExtras(value.quota), known.accounts),
    aliases: keepSuccessful(aliases, (value) => value, known.aliases),
    counts: keepSuccessful(
      overview,
      (value) => ({ providers: value.providerCount, enabledModels: value.enabledModelCount }),
      known.counts
    ),
    now: dayjs().valueOf()
  }
}

export function useProvidersData() {
  const { t } = useTranslation()
  const [data, setData] = useState<ProvidersData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requests = useRef({ generation: 0, pending: 0, foreground: false, mounted: false })

  const cancelBackground = useCallback(() => {
    if (!requests.current.foreground) requests.current.generation++
  }, [])

  const finishRead = useCallback((background: boolean, generation: number) => {
    requests.current.pending--
    if (background || !requests.current.mounted || requests.current.generation !== generation) return
    requests.current.foreground = false
    setLoading(false)
  }, [])

  const reportReadError = useCallback(
    (background: boolean, generation: number, err: unknown) => {
      if (background || !requests.current.mounted || requests.current.generation !== generation) return
      setError(err instanceof Error ? err.message : t('providers.screen.loadFailed'))
    },
    [t]
  )

  const load = useCallback(
    async (background: boolean) => {
      // Polls never overlap another read. A foreground save/reload may
      // supersede a slow poll, whose older response must then be ignored.
      if (background && requests.current.pending > 0) return
      const generation = ++requests.current.generation
      requests.current.pending++
      requests.current.foreground = !background
      if (!background) setLoading(true)
      const isCurrent = () => requests.current.mounted && requests.current.generation === generation
      try {
        const read = await readProviders()
        if (!isCurrent()) return
        if (read[0].status === 'rejected') throw read[0].reason
        setData((previous) => mergeRead(previous, read))
        setError(null)
      } catch (err) {
        // A transient background failure is not a replacement for the last
        // good data. Explicit initial/reload failures still surface normally.
        reportReadError(background, generation, err)
      } finally {
        finishRead(background, generation)
      }
    },
    [finishRead, reportReadError]
  )

  const reload = useCallback(() => load(false), [load])
  const reloadBackground = useCallback(() => load(true), [load])

  useEffect(() => {
    requests.current.mounted = true
    void reload()
    return () => {
      requests.current.mounted = false
      requests.current.generation++
    }
  }, [reload])

  return { data, error, loading, reload, reloadBackground, cancelBackground }
}

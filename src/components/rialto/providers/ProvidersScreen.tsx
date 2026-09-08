/**
 * One of the two provider lists — Subscriptions or API keys.
 *
 * Providers used to be a single master-detail screen: an 18rem rail of
 * every provider, grouped under those two headings, beside the detail it
 * selected into. Three columns of chrome left the detail 896px at 1440,
 * which is why its account emails truncated and its six price columns
 * rendered as six dashes. The rail's headings are now the sidebar's two
 * sub-entries and each is a list of its own; the detail is
 * ProviderDetailScreen, at full width.
 *
 * The screen still reads the whole catalogue rather than one kind of it.
 * `/api/providers` returns every provider in one response and the
 * subtitle counts across both lists on purpose — "4 of 7 providers are
 * live" is an install-wide fact, and fetching half of it twice would
 * make the two lists disagree while one of them was stale.
 */
import type { TFunction } from 'i18next'
import { useCallback, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { SectionHead } from '@/components/rialto/settings/fields'
import { refreshPrices } from './actions'
import { BusyOverlay } from './BusyOverlay'
import { enabledCountOf, listedModelsOf, providerState } from './derive'
import { type ListedProvider, ProviderTable } from './ProviderTable'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { vendorBrand, vendorLabel } from './vendor-labels'

type Kind = 'subscription' | 'api_key'

const COPY: Record<Kind, { subtitle: string; note: string; add: string; empty: string }> = {
  subscription: {
    subtitle: 'providers.list.subscriptionsSubtitle',
    note: 'providers.list.subscriptionsNote',
    add: 'providers.list.addSubscription',
    empty: 'providers.list.subscriptionsEmpty'
  },
  api_key: {
    subtitle: 'providers.list.apiKeysSubtitle',
    note: 'providers.list.apiKeysNote',
    add: 'providers.screen.addProvider',
    empty: 'providers.list.apiKeysEmpty'
  }
}

function listOf(data: ProvidersData, kind: Kind): ListedProvider[] {
  return data.providers
    .filter((provider) => (kind === 'subscription') === (provider.auth_mode === 'subscription'))
    .map((provider) => {
      const entry = data.catalog.find((e) => e.name === provider.name)
      const subscription = data.subscriptions.get(provider.name)
      return {
        provider,
        label: entry === undefined ? provider.name : vendorLabel(entry.name, entry.displayName),
        // A provider with no catalog entry is a hand-added one — name the
        // host it calls.
        vendor: entry === undefined ? new URL(provider.api_base_url).hostname : vendorBrand(entry.name, entry.vendor),
        state: providerState(provider, subscription),
        subscription
      }
    })
}

/** "3 accounts across 3 providers · 10 of 16 models enabled". */
function summary(entries: ListedProvider[], kind: Kind, t: TFunction): string {
  const enabled = entries.reduce((sum, e) => sum + enabledCountOf(e.provider), 0)
  const models = entries.reduce((sum, e) => sum + listedModelsOf(e.provider).length, 0)
  if (kind === 'subscription') {
    const accounts = entries.reduce(
      (sum, e) => sum + (e.subscription === undefined ? 0 : e.subscription.accounts.length),
      0
    )
    return t('providers.list.subscriptionsSummary', { accounts, providers: entries.length, enabled, models })
  }
  const keyless = entries.filter((e) => e.provider.api_key === null || e.provider.api_key === '').length
  return t('providers.list.apiKeysSummary', { providers: entries.length, enabled, models, keyless })
}

export function ProvidersScreen({ kind }: { kind: Kind }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useProvidersData()
  const [pending, setPending] = useState<string | null>(null)

  const copy = COPY[kind]
  const goAdd = useCallback(() => navigate('/providers/connect'), [navigate])

  // A price scrape produces no visible change on an install with no
  // api_key providers even when it succeeds, so silence cannot be read as
  // success here — it narrates itself either way.
  const refresh = useCallback(() => {
    setPending(t('providers.screen.refreshingPrices'))
    refreshPrices()
      .then(reload)
      .then(() => toast.success(t('providers.screen.pricesRefreshed')))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setPending(null))
  }, [reload, t])

  const entries = data === null ? [] : listOf(data, kind)

  return (
    <Screen
      // No crumbs: this route IS a sidebar child, so Screen already
      // renders "Providers / Subscriptions" from the nav tree. Naming it
      // again here spelled the leaf twice.
      subtitle={t(copy.subtitle)}
      actions={
        <>
          <RButton variant='ghost' icon='ri-price-tag-3-line' onClick={refresh} disabled={pending !== null || loading}>
            {t('providers.screen.refreshPrices')}
          </RButton>
          <RButton variant='primary' icon='ri-add-line' onClick={goAdd}>
            {t(copy.add)}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <div className='relative min-w-0'>
          {/* No title: the breadcrumb and the sidebar both say
              "Subscriptions" already. */}
          <SectionHead meta={summary(entries, kind, t)} />

          <div className='px-6 pb-4'>
            <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
              <i className='ri-information-line mr-1 align-[-1px]' />
              <Trans
                i18nKey={copy.note}
                components={{
                  mono: <span className='font-mono' />,
                  strong: <span className='font-medium text-foreground' />
                }}
              />
            </div>
          </div>

          {entries.length === 0 ? (
            <div className='px-6 py-6 text-xs text-muted-foreground'>{t(copy.empty)}</div>
          ) : (
            <ProviderTable entries={entries} kind={kind} quota={data.quota} />
          )}

          {pending === null ? null : <BusyOverlay label={pending} />}
        </div>
      )}
    </Screen>
  )
}

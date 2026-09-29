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
import { type ReactNode, useCallback } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { SectionHead } from '@/components/rialto/settings/fields'
import { usePhone } from '@/hooks/use-phone'
import { BusyOverlay } from './BusyOverlay'
import { enabledCountOf, listedModelsOf, providerState, type QuotaIndex } from './derive'
import { ProviderListPhone } from './ProviderListPhone'
import { type ListedProvider, ProviderTable } from './ProviderTable'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { type RefreshScope, useRefresh } from './useRefresh'
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
    add: 'providers.screen.addKey',
    empty: 'providers.list.apiKeysEmpty'
  }
}

// What Refresh re-reads besides the catalog. The Subscriptions list's
// quota column is a five-minute-old reading, and this asks upstream for it
// now. The API keys list has nothing that ages the same way: its rows
// change through the catalog alone.
const REFRESH_SCOPE: Record<Kind, RefreshScope> = {
  subscription: { accounts: 'all' },
  api_key: { accounts: 'none' }
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
  const { pending, refresh } = useRefresh(REFRESH_SCOPE[kind], reload)

  const copy = COPY[kind]
  const goAdd = useCallback(() => navigate('/providers/connect'), [navigate])

  const entries = data === null ? [] : listOf(data, kind)
  const phone = usePhone()

  const buttons = (
    <>
      <RButton variant='ghost' icon='ri-refresh-line' onClick={refresh} disabled={pending !== null || loading}>
        {t('providers.screen.refresh')}
      </RButton>
      <RButton variant='primary' icon='ri-add-line' onClick={goAdd}>
        {t(copy.add)}
      </RButton>
    </>
  )

  return (
    <Screen
      // The sidebar's own sub-entry (Subscriptions / API keys) already
      // says which list this is, so the header repeating it as
      // "Providers / Subscriptions" spelled the leaf twice — the mocks
      // call renderShell with crumbs: [] for exactly this reason.
      hideChildCrumb
      subtitle={t(copy.subtitle)}
      // On a phone the pair moves up into the header, icon-only: beside
      // the summary they squeezed it into a seven-line column.
      actions={phone ? buttons : undefined}
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <ListBody phone={phone} entries={entries} kind={kind} quota={data.quota} pending={pending} buttons={buttons} />
      )}
    </Screen>
  )
}

/** Everything under the header, in its phone or its desktop shape. */
function ListBody({
  phone,
  entries,
  kind,
  quota,
  pending,
  buttons
}: {
  phone: boolean
  entries: ListedProvider[]
  kind: Kind
  quota: QuotaIndex
  pending: string | null
  buttons: ReactNode
}) {
  const { t } = useTranslation()
  const copy = COPY[kind]
  if (phone) {
    // No explainer note: it is the same paragraph on every visit, and on
    // a phone it pushed the first row below the fold. The buttons are in
    // the header instead (see ProvidersScreen).
    return (
      <div className='relative min-w-0'>
        <p className='px-4 py-3 text-[12px] text-muted-foreground'>{summary(entries, kind, t)}</p>
        {entries.length === 0 ? (
          <div className='px-4 py-6 text-xs text-muted-foreground'>{t(copy.empty)}</div>
        ) : (
          <ProviderListPhone entries={entries} kind={kind} quota={quota} />
        )}
        {pending === null ? null : <BusyOverlay label={pending} />}
      </div>
    )
  }
  return (
    <div className='relative min-w-0'>
      {/* No title: the breadcrumb and the sidebar both say
          "Subscriptions" already. The Refresh / Add pair sits in this
          row, beside the summary text, not in the sticky top header —
          matching the mock's single "flex items-center gap-3" row. */}
      <SectionHead meta={summary(entries, kind, t)} actions={buttons} />

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
        <ProviderTable entries={entries} kind={kind} quota={quota} />
      )}

      {pending === null ? null : <BusyOverlay label={pending} />}
    </div>
  )
}

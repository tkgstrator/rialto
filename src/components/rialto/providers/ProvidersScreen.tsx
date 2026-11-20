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
 */
import { type ReactNode, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { SectionHead } from '@/components/rialto/settings/fields'
import { usePhone } from '@/hooks/use-phone'
import { apiKeyVendorName } from '@/shared/custom-provider'
import { BusyOverlay } from './BusyOverlay'
import { providerState, type QuotaIndex } from './derive'
import { ProviderListPhone } from './ProviderListPhone'
import { type ListedProvider, ProviderTable } from './ProviderTable'
import { useProvidersAutoRefresh } from './useProvidersAutoRefresh'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { type RefreshScope, useRefresh } from './useRefresh'
import { providerLabel, vendorBrand, vendorLabel } from './vendor-labels'

type Kind = 'subscription' | 'api_key'

const COPY: Record<Kind, { empty: string }> = {
  subscription: {
    empty: 'providers.list.subscriptionsEmpty'
  },
  api_key: {
    empty: 'providers.list.apiKeysEmpty'
  }
}

const REFRESH_SCOPE: Record<Kind, RefreshScope> = {
  subscription: { accounts: 'all' },
  api_key: { accounts: 'none' }
}

function listOf(data: ProvidersData, kind: Kind): ListedProvider[] {
  return data.providers
    .filter((provider) => (kind === 'subscription') === (provider.auth_mode === 'subscription'))
    .map((provider) => {
      const entry = data.catalog.find((e) => e.name === apiKeyVendorName(provider.name))
      const subscription = data.subscriptions.get(provider.name)
      return {
        provider,
        label:
          kind === 'api_key' && apiKeyVendorName(provider.name) === 'anthropic'
            ? vendorLabel('anthropic', 'anthropic')
            : providerLabel(provider, entry),
        // A provider with no catalog entry is a hand-added one — name the
        // host it calls.
        vendor: entry === undefined ? new URL(provider.api_base_url).hostname : vendorBrand(entry.name, entry.vendor),
        state: providerState(provider, subscription),
        subscription
      }
    })
}

export function ProvidersScreen({ kind }: { kind: Kind }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, error, loading, reload, reloadBackground, cancelBackground } = useProvidersData()
  const { pending, refresh } = useRefresh(REFRESH_SCOPE[kind], reload)
  useProvidersAutoRefresh({
    enabled: kind === 'subscription' && data !== null,
    paused: loading || pending !== null,
    refresh: reloadBackground,
    cancel: cancelBackground
  })

  const goAdd = useCallback(() => navigate('/providers/connect'), [navigate])

  const entries = data === null ? [] : listOf(data, kind)
  const phone = usePhone()

  const actions = (
    <>
      <RButton variant='outline' icon='ri-refresh-line' onClick={refresh} disabled={pending !== null || loading}>
        {t('providers.screen.refresh')}
      </RButton>
      <RButton variant='primary' icon='ri-add-line' onClick={goAdd}>
        {t('common.add')}
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
      actions={phone ? actions : undefined}
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <ListBody phone={phone} entries={entries} kind={kind} quota={data.quota} pending={pending} actions={actions} />
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
  actions
}: {
  phone: boolean
  entries: ListedProvider[]
  kind: Kind
  quota: QuotaIndex
  pending: string | null
  actions: ReactNode
}) {
  const { t } = useTranslation()
  const copy = COPY[kind]
  if (phone) {
    return (
      <div className='relative min-w-0'>
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
      <SectionHead actions={actions} />

      {entries.length === 0 ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t(copy.empty)}</div>
      ) : (
        <ProviderTable entries={entries} kind={kind} quota={quota} />
      )}
      {pending === null ? null : <BusyOverlay label={pending} />}
    </div>
  )
}

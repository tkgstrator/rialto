/**
 * One provider's own page — accounts or credentials, request shape, and
 * the model list.
 *
 * Was the right-hand pane of a master-detail screen, 896px wide behind a
 * 256px sidebar and a 288px rail. The rail's two groups are sidebar
 * sub-entries now (see ProvidersScreen), and this is a page reached from
 * one of those lists and left by the breadcrumb — the same shape a token
 * detail already has.
 *
 * Every mutation is a write-then-reread: the server derives model rows,
 * prices and test status, so the response body is never the whole truth
 * about what changed.
 */
import type { TFunction } from 'i18next'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import {
  refreshPrices,
  removeProvider,
  saveApiKey,
  setModelEffort,
  setModelTier,
  syncModels,
  testModels,
  toggleModel,
  toggleProvider
} from './actions'
import { BusyOverlay } from './BusyOverlay'
import { disabledModelsOf, enabledCountOf, listedModelsOf, providerState } from './derive'
import { ProviderDetail } from './ProviderDetail'
import type { Provider } from './types'
import { useProvidersData } from './useProvidersData'
import { vendorBrand, vendorLabel } from './vendor-labels'

/**
 * What deleting this provider costs, as a sentence to confirm.
 *
 * Removal cascades to every model, the stored key or OAuth account, and
 * any chain entry naming one of those models — the server reports the
 * dropped entries only as an after-the-fact warning. Revoking an access
 * token already asks first, and this is the more destructive of the two.
 */
function removeConfirmMessage(provider: Provider, label: string, t: TFunction): string {
  return t('providers.detail.removeConfirm', {
    name: label,
    models: listedModelsOf(provider).length
  })
}

export function ProviderDetailScreen() {
  const { t } = useTranslation()
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useProvidersData()
  const [busy, setBusy] = useState(false)
  // Label of the action currently running, or null when nothing needs a
  // backdrop. Deliberately not derived from `busy`: `busy` gates every
  // button, including the per-row writes that finish in milliseconds, and
  // dimming the screen for those would flicker. Only the callers that
  // pass a label get an overlay — see BusyOverlay for which and why.
  const [pending, setPending] = useState<string | null>(null)

  // The catch is not optional. Without it a failed action rejects into
  // nothing — the spinner stops, the screen re-reads unchanged data, and
  // a refresh that never reached the vendor looks exactly like one that
  // did. Several of these actions (price scrape, model sync) also produce
  // no visible change even when they succeed.
  const run = useCallback(
    async (work: () => Promise<void>, notice?: { pending: string; done: string }) => {
      setBusy(true)
      if (notice !== undefined) setPending(notice.pending)
      try {
        await work()
        await reload()
        // Only the narrated actions confirm themselves, for the reason
        // given above: a scrape that changed nothing looks identical to
        // one that never ran. The per-row writes are exempt because the
        // row they changed is the confirmation.
        if (notice !== undefined) toast.success(notice.done)
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setPending(null)
      }
    },
    [reload]
  )

  const provider = data === null ? undefined : data.providers.find((p) => p.name === name)

  if (error !== null) {
    return (
      <Screen>
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      </Screen>
    )
  }
  if (data === null || loading) {
    return (
      <Screen>
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      </Screen>
    )
  }
  if (provider === undefined) {
    return (
      <Screen crumbs={[{ label: t('providers.detail.notFound') }]}>
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('providers.detail.notFoundBody', { name })}</div>
      </Screen>
    )
  }

  const entry = data.catalog.find((e) => e.name === provider.name)
  const label = entry === undefined ? provider.name : vendorLabel(entry.name, entry.displayName)
  const vendor = entry === undefined ? new URL(provider.api_base_url).hostname : vendorBrand(entry.name, entry.vendor)
  const subscription = data.subscriptions.get(provider.name)
  const subscriptionKind = provider.auth_mode === 'subscription'
  // The list this provider came from, so the breadcrumb leads back to the
  // half of Providers it belongs to rather than to the section root.
  const listCrumb = subscriptionKind
    ? { label: t('providers.rail.subscriptions'), href: '/providers/subscriptions' }
    : { label: t('providers.rail.apiKeys'), href: '/providers/api-keys' }

  return (
    <Screen
      crumbs={[listCrumb, { label }]}
      subtitle={t('providers.screen.apiKeySubtitle', {
        label: vendor,
        enabled: enabledCountOf(provider),
        total: listedModelsOf(provider).length
      })}
      actions={
        <>
          <RButton
            variant='ghost'
            icon='ri-price-tag-3-line'
            onClick={() =>
              run(refreshPrices, {
                pending: t('providers.screen.refreshingPrices'),
                done: t('providers.screen.pricesRefreshed')
              })
            }
            disabled={busy}
          >
            {t('providers.screen.refreshPrices')}
          </RButton>
          <RButton variant='primary' icon='ri-add-line' onClick={() => navigate('/providers/connect')}>
            {t('providers.screen.addProvider')}
          </RButton>
        </>
      }
    >
      <div className='relative min-w-0'>
        <ProviderDetail
          provider={provider}
          label={label}
          state={providerState(provider, subscription)}
          subscription={subscription}
          catalogEntry={entry}
          transformers={data.transformers}
          quota={data.quota}
          now={data.now}
          busy={busy}
          onToggleModel={(model, next) => run(() => toggleModel(provider, model, next))}
          onModelTier={(model, next) => run(() => setModelTier(provider, model, next))}
          onModelEffort={(model, next) => run(() => setModelEffort(provider, model, next))}
          onToggleProvider={(next) => run(() => toggleProvider(provider, next))}
          onSaveKey={(key) => run(() => saveApiKey(provider, key))}
          onTestAll={() => {
            const off = new Set(disabledModelsOf(provider))
            const enabled = listedModelsOf(provider).filter((m) => !off.has(m))
            run(() => testModels(provider.name, enabled))
          }}
          onSync={() =>
            run(syncModels, {
              pending: t('providers.detail.syncingModels'),
              done: t('providers.detail.modelsSynced')
            })
          }
          removeConfirm={removeConfirmMessage(provider, label, t)}
          onRemove={() =>
            run(async () => {
              await removeProvider(provider.name)
              navigate(listCrumb.href)
            })
          }
        />
        {pending === null ? null : <BusyOverlay label={pending} />}
      </div>
    </Screen>
  )
}

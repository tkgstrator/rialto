/**
 * Providers — "where requests can go", as one master-detail screen.
 *
 * Absorbs Providers + Subscriptions + ModelsDashboard + the transformer
 * editor. Those were four top-level entries for one decision, which is why
 * an operator had to visit three of them to answer "can this vendor serve
 * this model right now".
 */
import type { TFunction } from 'i18next'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import type { RouterConfig } from '@/schemas/domain/router'
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
import { disabledModelsOf, enabledCountOf, listedModelsOf, providerState, routerBindingsFor } from './derive'
import { ProviderDetail } from './ProviderDetail'
import { ProviderRail, type RailProvider } from './ProviderRail'
import type { CatalogEntry, Provider } from './types'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { vendorBrand, vendorLabel } from './vendor-labels'

const findCatalog = (catalog: CatalogEntry[], name: string): CatalogEntry | undefined =>
  catalog.find((e) => e.name === name)

const labelFor = (entry: CatalogEntry | undefined, name: string): string =>
  entry === undefined ? name : vendorLabel(entry.name, entry.displayName)

/** A provider with no catalog entry is a hand-added one — name the host it calls. */
const vendorFor = (entry: CatalogEntry | undefined, p: Provider): string =>
  entry === undefined ? new URL(p.api_base_url).hostname : vendorBrand(entry.name, entry.vendor)

function buildRail(data: ProvidersData): RailProvider[] {
  return data.providers.map((provider) => {
    const entry = findCatalog(data.catalog, provider.name)
    const subscription = data.subscriptions.get(provider.name)
    return {
      provider,
      label: labelFor(entry, provider.name),
      vendor: vendorFor(entry, provider),
      state: providerState(provider, subscription),
      subscription
    }
  })
}

function summarySubtitle(data: ProvidersData, t: TFunction): string {
  const providers = data.counts === null ? data.providers.length : data.counts.providers
  const models =
    data.counts === null ? data.providers.reduce((sum, p) => sum + enabledCountOf(p), 0) : data.counts.enabledModels
  const accounts = [...data.subscriptions.values()].reduce((sum, s) => sum + s.accounts.length, 0)
  return t('providers.screen.summarySubtitle', { providers, models, accounts })
}

/** The header line: a per-provider count for api_key providers, the
 *  install-wide summary otherwise. */
function subtitleFor(data: ProvidersData | null, selected: RailProvider | undefined, t: TFunction): string | undefined {
  if (data === null) return undefined
  if (selected === undefined) return summarySubtitle(data, t)
  const p = selected.provider
  if (p.auth_mode === 'subscription') return summarySubtitle(data, t)
  return t('providers.screen.apiKeySubtitle', {
    label: selected.label,
    enabled: enabledCountOf(p),
    total: listedModelsOf(p).length
  })
}

/**
 * What deleting this provider costs, as a sentence to confirm.
 *
 * Removal cascades to every model, the stored key or OAuth account, and
 * any router slot pointing at one of them — the server reports the
 * cleared slots only as an after-the-fact warning. Revoking an access
 * token already asks first, and this is the more destructive of the two.
 */
function removeConfirmMessage(entry: RailProvider, router: RouterConfig | undefined, t: TFunction): string {
  return t('providers.detail.removeConfirm', {
    name: entry.label,
    models: listedModelsOf(entry.provider).length,
    bindings: routerBindingsFor(router, entry.provider.name)
  })
}

export function ProvidersScreen() {
  const { t } = useTranslation()
  const { name } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  // Only for the removal confirm's blast radius — the screen's own data
  // comes from useProvidersData.
  const { config } = useConfig()
  const { data, error, loading, reload } = useProvidersData()
  const [busy, setBusy] = useState(false)
  // Label of the action currently running, or null when nothing needs a
  // backdrop. Deliberately not derived from `busy`: `busy` gates every
  // button, including the per-row writes that finish in milliseconds, and
  // dimming the screen for those would flicker. Only the callers that
  // pass a label get an overlay — see BusyOverlay for which and why.
  const [pending, setPending] = useState<string | null>(null)

  // Every mutation is a write-then-reread: the server derives model rows,
  // prices and test status, so the response body is never the whole truth
  // about what changed.
  //
  // The catch is not optional. Without it a failed action rejects into
  // nothing — the spinner stops, the screen re-reads unchanged data, and a
  // refresh that never reached the vendor looks exactly like one that did.
  // Several of these actions (price scrape, model sync) also produce no
  // visible change on a install with no providers even when they succeed,
  // so silence cannot be read as success here.
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

  const rail = data === null ? [] : buildRail(data)
  const selected = name === undefined ? rail[0] : rail.find((e) => e.provider.name === name)
  const goAdd = useCallback(() => navigate('/providers/connect'), [navigate])

  // Hoisted out of the JSX: the removal confirm needs the router to count
  // the slots it would clear.
  const router = config === null ? undefined : config.Router
  const subtitle = subtitleFor(data, selected, t)

  return (
    <Screen
      // The route can name the section but not which provider is open,
      // so the leaf is the only crumb this screen passes.
      crumbs={selected === undefined ? [] : [{ label: selected.label }]}
      subtitle={subtitle}
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
            disabled={busy || loading}
          >
            {t('providers.screen.refreshPrices')}
          </RButton>
          <RButton variant='primary' icon='ri-add-line' onClick={goAdd}>
            {t('providers.screen.addProvider')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <div className='relative grid h-full grid-cols-[18rem_1fr]'>
          <ProviderRail
            entries={rail}
            activeName={selected === undefined ? null : selected.provider.name}
            quota={data.quota}
            onAdd={goAdd}
          />
          {selected === undefined ? (
            <div className='px-6 py-6 text-xs text-muted-foreground'>{t('providers.screen.emptyRail')}</div>
          ) : (
            <ProviderDetail
              provider={selected.provider}
              label={selected.label}
              state={selected.state}
              subscription={selected.subscription}
              catalogEntry={findCatalog(data.catalog, selected.provider.name)}
              transformers={data.transformers}
              quota={data.quota}
              now={data.now}
              busy={busy}
              onToggleModel={(model, next) => run(() => toggleModel(selected.provider, model, next))}
              onModelTier={(model, next) => run(() => setModelTier(selected.provider, model, next))}
              onModelEffort={(model, next) => run(() => setModelEffort(selected.provider, model, next))}
              onToggleProvider={(next) => run(() => toggleProvider(selected.provider, next))}
              onSaveKey={(key) => run(() => saveApiKey(selected.provider, key))}
              onTestAll={() => {
                const off = new Set(disabledModelsOf(selected.provider))
                const enabled = listedModelsOf(selected.provider).filter((m) => !off.has(m))
                run(() => testModels(selected.provider.name, enabled))
              }}
              onSync={() =>
                run(syncModels, {
                  pending: t('providers.detail.syncingModels'),
                  done: t('providers.detail.modelsSynced')
                })
              }
              removeConfirm={removeConfirmMessage(selected, router, t)}
              onRemove={() =>
                run(async () => {
                  await removeProvider(selected.provider.name)
                  navigate('/providers')
                })
              }
            />
          )}
          {pending === null ? null : <BusyOverlay label={pending} />}
        </div>
      )}
    </Screen>
  )
}

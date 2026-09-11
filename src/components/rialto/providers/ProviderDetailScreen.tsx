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
 * The page reads until Edit is pressed, and an edit is staged rather than
 * written: each change lands in a draft the page renders through, and
 * Save writes the difference in one go. Every write is still followed by
 * a re-read: the server derives model rows, prices and test status, so a
 * response body is never the whole truth about what changed.
 */
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { removeProvider, type SaveFailure, saveProviderEdits, testModels } from './actions'
import { BusyOverlay } from './BusyOverlay'
import { disabledModelsOf, enabledCountOf, listedModelsOf, providerState } from './derive'
import { ProviderDetail } from './ProviderDetail'
import { applyDraft, EMPTY_DRAFT, hasChanges, type ProviderDraft, savePlan } from './provider-draft'
import type { Provider } from './types'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { type RefreshScope, useRefresh } from './useRefresh'
import { vendorBrand, vendorLabel } from './vendor-labels'

const SAVE_FAILURE_KEYS: Record<SaveFailure['write'], string> = {
  provider: 'providers.detail.saveFailedProvider',
  tier: 'providers.detail.saveFailedTier',
  effort: 'providers.detail.saveFailedEffort'
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// A subscription provider's page refreshes its accounts along with the
// catalog; an api_key provider has none.
const refreshScopeOf = (provider: Provider | undefined): RefreshScope =>
  provider !== undefined && provider.auth_mode === 'subscription'
    ? { accounts: 'provider', provider: provider.name }
    : { accounts: 'none' }

/** What the page calls the provider, and where its breadcrumb leads back to. */
function framingOf(data: ProvidersData, provider: Provider, t: TFunction) {
  const entry = data.catalog.find((e) => e.name === provider.name)
  return {
    entry,
    label: entry === undefined ? provider.name : vendorLabel(entry.name, entry.displayName),
    vendor: entry === undefined ? new URL(provider.api_base_url).hostname : vendorBrand(entry.name, entry.vendor),
    // The list this provider came from, so the breadcrumb leads back to the
    // half of Providers it belongs to rather than to the section root.
    listCrumb:
      provider.auth_mode === 'subscription'
        ? { label: t('providers.rail.subscriptions'), href: '/providers/subscriptions' }
        : { label: t('providers.rail.apiKeys'), href: '/providers/api-keys' }
  }
}

/** Accounts across every subscription provider, for the summary subtitle below. */
const subscriptionAccountCountOf = (data: ProvidersData): number =>
  [...data.subscriptions.values()].reduce((sum, s) => sum + s.accounts.length, 0)

/**
 * The header subtitle.
 *
 * An api_key provider's page reports itself — the vendor and its own model
 * count — because each one is billed on its own. A subscription provider's
 * quota pools across the whole fleet through the tier a model carries, so
 * its page reports the same install-wide numbers Overview does instead of
 * a figure specific to the one account list below it; `data.counts` is the
 * server's own tally so the two screens never disagree, falling back to a
 * client-side count only when the overview call it rode in on failed.
 */
function subtitleOf(data: ProvidersData, provider: Provider, shown: Provider, vendor: string, t: TFunction): string {
  if (provider.auth_mode !== 'subscription') {
    return t('providers.screen.apiKeySubtitle', {
      label: vendor,
      enabled: enabledCountOf(shown),
      total: listedModelsOf(shown).length
    })
  }
  const counts =
    data.counts === null
      ? {
          providers: data.providers.length,
          enabledModels: data.providers.reduce((sum, p) => sum + enabledCountOf(p), 0)
        }
      : data.counts
  return t('providers.screen.summarySubtitle', {
    providers: counts.providers,
    models: counts.enabledModels,
    accounts: subscriptionAccountCountOf(data)
  })
}

export function ProviderDetailScreen() {
  const { t } = useTranslation()
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useProvidersData()
  const { confirm, dialog } = useConfirm()
  // Gates every button while a save, a removal or a test run is out.
  const [busy, setBusy] = useState(false)
  // Edit mode belongs to the provider it was entered on, rather than being
  // a bare boolean: moving to another provider's page shows that page
  // reading, not holding an edit that was never its own.
  const [edit, setEdit] = useState<{ provider: string; draft: ProviderDraft } | null>(null)

  const provider = data === null ? undefined : data.providers.find((p) => p.name === name)
  const { pending, refresh } = useRefresh(refreshScopeOf(provider), reload)

  // The catch is not optional. Without it a failed action rejects into
  // nothing — the spinner stops, the screen re-reads unchanged data, and
  // an action that never reached the server looks exactly like one that
  // did.
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
      await reload()
    } catch (err: unknown) {
      toast.error(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

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

  const { entry, label, vendor, listCrumb } = framingOf(data, provider, t)
  const subscription = data.subscriptions.get(provider.name)
  const draft = edit !== null && edit.provider === provider.name ? edit.draft : null
  const editing = draft !== null
  // What the page renders: the provider as Save would leave it.
  const shown = draft === null ? provider : applyDraft(provider, draft)
  const plan = draft === null ? null : savePlan(provider, draft)
  const stage = (change: (current: ProviderDraft) => ProviderDraft) =>
    setEdit((prev) => (prev === null ? prev : { ...prev, draft: change(prev.draft) }))
  const locked = busy || pending !== null

  // Leaves edit mode whether or not every write landed. A failed write
  // stops the ones after it, and the re-read shows which of those before
  // it went through — an edit kept on screen past that point would be a
  // mix of saved and unsaved values nothing on the page tells apart.
  const save = () => {
    if (plan === null) return
    setBusy(true)
    saveProviderEdits(provider, plan)
      .then(async (failure) => {
        await reload()
        setEdit(null)
        if (failure === null) {
          toast.success(t('providers.detail.saved', { name: label }))
          return
        }
        const model = failure.model === null ? '' : failure.model
        toast.error(t(SAVE_FAILURE_KEYS[failure.write], { model, message: failure.message }))
      })
      .catch((err: unknown) => toast.error(messageOf(err)))
      .finally(() => setBusy(false))
  }

  // Removal cascades to every model, the stored key and any chain entry
  // naming one of those models, and the server reports the dropped
  // entries only as an after-the-fact warning — so the cost is stated
  // before the click, not after it.
  const remove = async () => {
    const confirmed = await confirm({
      title: t('providers.detail.removeTitle', { name: label }),
      description: t('providers.detail.removeDescription', { models: listedModelsOf(provider).length }),
      confirmLabel: t('common.remove'),
      icon: 'ri-delete-bin-line'
    })
    if (!confirmed) return
    await run(async () => {
      await removeProvider(provider.name)
      navigate(listCrumb.href)
    })
  }

  return (
    <Screen
      crumbs={[listCrumb, { label }]}
      subtitle={subtitleOf(data, provider, shown, vendor, t)}
      actions={
        <>
          {/* Locked while editing, with Add: a refresh re-reads the page and
              Add leaves it, and an unsaved edit would go either way. */}
          <RButton variant='ghost' icon='ri-refresh-line' onClick={refresh} disabled={locked || editing}>
            {t('providers.screen.refresh')}
          </RButton>
          <RButton
            variant='primary'
            icon='ri-add-line'
            onClick={() => navigate('/providers/connect')}
            disabled={editing}
          >
            {t(provider.auth_mode === 'subscription' ? 'providers.list.addSubscription' : 'providers.screen.addKey')}
          </RButton>
        </>
      }
    >
      <div className='relative min-w-0'>
        <ProviderDetail
          provider={shown}
          label={label}
          state={providerState(provider, subscription)}
          subscription={subscription}
          catalogEntry={entry}
          transformers={data.transformers}
          quota={data.quota}
          now={data.now}
          busy={locked}
          editing={editing}
          canSave={plan !== null && hasChanges(plan)}
          onEdit={() => setEdit({ provider: provider.name, draft: EMPTY_DRAFT })}
          onRevert={() => setEdit(null)}
          onSave={save}
          onRemove={remove}
          onTestAll={() => {
            const off = new Set(disabledModelsOf(provider))
            const enabled = listedModelsOf(provider).filter((m) => !off.has(m))
            run(() => testModels(provider.name, enabled))
          }}
          onToggleProvider={(next) => stage((d) => ({ ...d, enabled: next }))}
          onToggleModel={(model, next) => stage((d) => ({ ...d, models: { ...d.models, [model]: next } }))}
          onModelTier={(model, next) => stage((d) => ({ ...d, tiers: { ...d.tiers, [model]: next } }))}
          onModelEffort={(model, next) => stage((d) => ({ ...d, efforts: { ...d.efforts, [model]: next } }))}
          onReplaceKey={(key) => stage((d) => ({ ...d, apiKey: key }))}
        />
        {pending === null ? null : <BusyOverlay label={pending} />}
      </div>
      {dialog}
    </Screen>
  )
}

/**
 * Detail pane for the provider selected in the rail.
 *
 * One screen for both auth modes, because they differ in exactly three
 * places: a subscription provider shows accounts where an api_key one
 * shows a key, only the api_key one has real per-token prices, and only
 * the api_key one has a model list long enough to need filtering.
 *
 * The pane reads until Edit is pressed. Everything on it that changes the
 * provider — the switch Routing reads, the key, each model's tier, effort
 * and switch — used to write on touch, one stray click from changing what
 * Routing sends where. Those controls now only work while editing, and
 * the screen holds what they change until Save (see provider-draft).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pager } from '@/components/rialto/Pager'
import { Pill, RButton, Toggle } from '@/components/rialto/primitives'
import { AccountsPanel } from './AccountsPanel'
import { CredentialsPanel } from './CredentialsPanel'
import {
  buildModelRows,
  enabledCountOf,
  hasCredential,
  hidesAsLegacy,
  listedModelsOf,
  type ModelRow,
  type ProviderState,
  passesShow,
  type QuotaIndex,
  type ShowMode
} from './derive'
import { ModelsTable } from './ModelsTable'
import { ApiKeyRequestShape, SubscriptionRequestShape } from './RequestShape'
import { SwitchReading } from './SwitchReading'
import type { CatalogEntry, Provider, ReasoningEffort, SubscriptionWire, Tier, TransformerWire } from './types'

const SHOW_LABEL_KEYS: Record<ShowMode, string> = {
  priced: 'providers.models.showPriced',
  enabled: 'providers.models.showEnabled',
  all: 'providers.models.showAll'
}

const STATE_LABEL_KEYS: Record<ProviderState, string> = {
  off: 'providers.rail.stateOff',
  live: 'providers.rail.stateLive',
  invalid: 'providers.rail.stateInvalid',
  unknown: 'providers.rail.stateUnknown'
}

// Each click widens the list from the default, then wraps.
const NEXT_SHOW: Record<ShowMode, ShowMode> = { enabled: 'priced', priced: 'all', all: 'enabled' }

/** Models per page on the api_key side. */
const PAGE = 8

function DetailHeader({
  provider,
  label,
  state,
  credentialed,
  busy,
  editing,
  canSave,
  onEdit,
  onRevert,
  onSave,
  onRemove,
  onTestAll,
  onToggleProvider
}: {
  provider: Provider
  label: string
  state: ProviderState
  credentialed: boolean
  busy: boolean
  editing: boolean
  canSave: boolean
  onEdit: () => void
  onRevert: () => void
  onSave: () => void
  onRemove: () => void
  onTestAll: () => void
  onToggleProvider: (next: boolean) => void
}) {
  const { t } = useTranslation()
  const subscription = provider.auth_mode === 'subscription'
  const stateTone = state === 'live' ? 'ok' : state === 'invalid' ? 'bad' : 'mute'
  const enabled = provider.enabled !== false
  const switchLabel = t('providers.detail.toggleProvider', { provider: label })
  const switchTitle = credentialed ? undefined : t('providers.detail.routableNeedsCredential')
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-4'>
      <div className='min-w-0'>
        <div className='flex items-center gap-2'>
          <h2 className='text-sm font-semibold'>{label}</h2>
          {subscription ? (
            <Pill tone='info'>{t('providers.connect.pillSubscription')}</Pill>
          ) : (
            <Pill tone='mute'>{t('providers.connect.pillApiKey')}</Pill>
          )}
          <Pill tone={stateTone}>{t(STATE_LABEL_KEYS[state])}</Pill>
        </div>
        <p className='mt-0.5 truncate font-mono text-[12px] text-muted-foreground' title={provider.api_base_url}>
          {provider.api_base_url}
        </p>
      </div>
      {/* Edit, then Revert / Save, for everything on this page that changes
          the provider; one Save writes it all. Remove only exists while
          editing, red, and still asks first. Test all is locked meanwhile:
          its results reload the page, and an unsaved edit would go with it. */}
      <div className='ml-auto flex items-center gap-2'>
        {/* The switch that Routing actually reads. It sits with the
            actions rather than in the model table, because it gates the
            whole provider: off, every model below it is unroutable no
            matter what its own row says.

            Locked with no credential, because `getEnabledModels` drops
            such a provider regardless of the flag — an operator turning
            it on there would be setting something nothing reads. Read
            that way outside Edit too: with no credential it shows off. */}
        <span className='flex items-center gap-1.5 pr-1 text-[12px] text-muted-foreground'>
          {t('providers.detail.routable')}
          {editing ? (
            <Toggle
              on={enabled}
              disabled={!credentialed}
              title={switchTitle}
              label={switchLabel}
              onClick={() => onToggleProvider(!enabled)}
            />
          ) : (
            <SwitchReading on={enabled && credentialed} title={switchTitle} label={switchLabel} />
          )}
        </span>
        <RButton variant='outline' icon='ri-pulse-line' onClick={onTestAll} disabled={busy || editing}>
          {t('providers.detail.testAll')}
        </RButton>
        {editing ? (
          <>
            {subscription ? null : (
              <RButton variant='danger' icon='ri-delete-bin-line' onClick={onRemove} disabled={busy}>
                {t('common.remove')}
              </RButton>
            )}
            <RButton variant='outline' icon='ri-arrow-go-back-line' onClick={onRevert} disabled={busy}>
              {t('common.revert')}
            </RButton>
            <RButton variant='primary' icon='ri-check-line' onClick={onSave} disabled={busy || !canSave}>
              {t('common.save')}
            </RButton>
          </>
        ) : (
          <RButton variant='outline' icon='ri-pencil-line' onClick={onEdit} disabled={busy}>
            {t('common.edit')}
          </RButton>
        )}
      </div>
    </div>
  )
}

function FilterBox({ value, onChange, wide }: { value: string; onChange: (v: string) => void; wide: boolean }) {
  const { t } = useTranslation()
  return (
    <div
      className={`flex h-7 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground ${wide ? 'w-44' : ''}`}
    >
      <i className='ri-search-line text-sm' />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(wide ? 'providers.models.filterModels' : 'providers.models.filter')}
        className='min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground'
      />
    </div>
  )
}

function ModelsSection({
  provider,
  rows,
  editing,
  onToggle,
  onTier,
  onEffort
}: {
  provider: Provider
  rows: ModelRow[]
  editing: boolean
  onToggle: (model: string, next: boolean) => void
  onTier: (model: string, next: Tier | null) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // "Enabled only": what a provider is actually routing to is the
  // question this table is opened with. The priced slice is one click
  // away for the times the question is what else could be switched on.
  const [show, setShow] = useState<ShowMode>('enabled')
  const [page, setPage] = useState(0)
  // Subscription side only. The api_key side reveals legacy rows through
  // its Show control; this side has none, and hiding a row with no way
  // back would make a legacy model impossible to switch on again.
  const [showLegacy, setShowLegacy] = useState(false)
  const isApiKey = provider.auth_mode !== 'subscription'

  const hidesLegacy = !isApiKey && !showLegacy
  const legacyHidden = hidesLegacy ? rows.filter(hidesAsLegacy).length : 0
  const needle = query.trim().toLowerCase()
  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(needle) && (!isApiKey || passesShow(r, show)) && (!hidesLegacy || !hidesAsLegacy(r))
  )
  // Subscription providers list a curated handful; only the api_key side
  // is long enough that paging earns its footer row.
  //
  // Paged rather than the "show 8 more" expander this used to be. On a
  // 61-model vendor that button ends in a 61-row table with no way back
  // up, and it can never say where you are — the range footer does both,
  // and it is the same control every other long list on the screen uses.
  //
  // The filters rebuild the list under the cursor, so a page index past
  // the new end has to fall back rather than render nothing.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE))
  const current = isApiKey ? Math.min(page, pageCount - 1) : 0
  const offset = current * PAGE
  const shownCount = isApiKey ? Math.min(PAGE, Math.max(0, filtered.length - offset)) : filtered.length

  return (
    <>
      <div className='flex items-center gap-3 px-6 pt-5 pb-3'>
        <h3 className='text-sm font-semibold'>{t('providers.models.title')}</h3>
        <span className='text-[12px] text-muted-foreground'>
          {t('providers.models.enabledCount', {
            enabled: enabledCountOf(provider),
            total: listedModelsOf(provider).length
          })}
        </span>
        {/* The count is the control that unfolds them, the way the
            revoked count is on Access tokens. A plain label would leave
            the rows unreachable and a separate switch would spend a
            control on a state most installs never look at. */}
        {legacyHidden === 0 ? null : (
          <button
            type='button'
            onClick={() => setShowLegacy(true)}
            className='text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground'
          >
            {t('providers.models.legacyHidden', { n: legacyHidden })}
          </button>
        )}
        {/* Filter, Show and the pager change what is on screen, not the
            provider, so they work whether or not the page is editing. */}
        <div className='ml-auto flex items-center gap-2'>
          {isApiKey ? (
            <button
              type='button'
              onClick={() => setShow(NEXT_SHOW[show])}
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-muted/60'
            >
              <span className='text-muted-foreground'>{t('providers.models.show')}</span> {t(SHOW_LABEL_KEYS[show])}
              <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
            </button>
          ) : null}
          <FilterBox value={query} onChange={setQuery} wide={isApiKey} />
        </div>
      </div>
      <ModelsTable
        rows={filtered}
        limit={isApiKey ? PAGE : undefined}
        offset={offset}
        withOverride={isApiKey}
        editable={editing}
        onToggle={onToggle}
        onTier={onTier}
        onEffort={onEffort}
      />
      {isApiKey ? (
        <Pager page={current} pageSize={PAGE} loaded={shownCount} total={filtered.length} onPage={setPage} />
      ) : null}
      <div className={isApiKey ? 'h-6' : 'h-8'} />
    </>
  )
}

export interface ProviderDetailProps {
  /** The provider as Save would leave it: as loaded while reading, with
   *  the staged edit applied while editing. */
  provider: Provider
  /** Catalog display name when the vendor is known, else the config slug. */
  label: string
  state: ProviderState
  subscription: SubscriptionWire | undefined
  catalogEntry: CatalogEntry | undefined
  transformers: TransformerWire[]
  quota: QuotaIndex
  now: number
  busy: boolean
  editing: boolean
  /** Whether the staged edit differs from what is stored. */
  canSave: boolean
  onEdit: () => void
  onRevert: () => void
  onSave: () => void
  onRemove: () => void
  onTestAll: () => void
  onToggleProvider: (next: boolean) => void
  onToggleModel: (model: string, next: boolean) => void
  /** Per-model tier override; null clears it back to name inference. */
  onModelTier: (model: string, next: Tier | null) => void
  /** Per-model reasoning effort; null clears it back to the vendor default. */
  onModelEffort: (model: string, next: ReasoningEffort | null) => void
  onReplaceKey: (key: string) => void
}

export function ProviderDetail(props: ProviderDetailProps) {
  const { provider, subscription, catalogEntry, transformers, quota, now } = props
  const subscriptionMode = provider.auth_mode === 'subscription'
  const rows = buildModelRows(provider, catalogEntry)
  return (
    <div className='min-w-0 overflow-y-auto'>
      <DetailHeader
        provider={provider}
        label={props.label}
        state={props.state}
        credentialed={hasCredential(provider, subscription)}
        busy={props.busy}
        editing={props.editing}
        canSave={props.canSave}
        onEdit={props.onEdit}
        onRevert={props.onRevert}
        onSave={props.onSave}
        onRemove={props.onRemove}
        onTestAll={props.onTestAll}
        onToggleProvider={props.onToggleProvider}
      />
      <div className='grid grid-cols-2 border-b border-border'>
        {subscriptionMode ? (
          <AccountsPanel subscription={subscription} quota={quota} now={now} />
        ) : (
          <CredentialsPanel
            key={provider.name}
            provider={provider}
            label={props.label}
            editing={props.editing}
            onReplace={props.onReplaceKey}
          />
        )}
        {subscriptionMode ? (
          <SubscriptionRequestShape provider={provider} transformers={transformers} />
        ) : (
          <ApiKeyRequestShape provider={provider} />
        )}
      </div>
      {/* Keyed on the provider: the filter, the Show mode and how far the
          list has been expanded are all about THIS provider's models. */}
      <ModelsSection
        key={provider.name}
        provider={provider}
        rows={rows}
        editing={props.editing}
        onToggle={props.onToggleModel}
        onTier={props.onModelTier}
        onEffort={props.onModelEffort}
      />
    </div>
  )
}

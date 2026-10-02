/**
 * Detail pane for the provider selected in the rail.
 *
 * One screen for both auth modes, because they differ in exactly three
 * places: a subscription provider shows accounts where an api_key one
 * shows a key, only the api_key one has real per-token prices, and only
 * the api_key one has a model list long enough to need filtering.
 *
 * The pane reads until Edit is pressed. Everything on it that changes the
 * provider — the switch Routing reads, the key, the tier aliases, each
 * model's effort and switch — used to write on touch, one stray click
 * from changing what Routing sends where. Those controls now only work
 * while editing, and the screen holds what they change until Save (see
 * provider-draft).
 */
import { useTranslation } from 'react-i18next'
import { Pill, RButton, Toggle } from '@/components/rialto/primitives'
import { AccountsPanel } from './AccountsPanel'
import { CredentialsPanel } from './CredentialsPanel'
import {
  type AccountExtrasIndex,
  buildModelRows,
  hasCredential,
  listedModelsOf,
  type ProviderState,
  type QuotaIndex
} from './derive'
import { ProviderModelsSection } from './ProviderModelsSection'
import { ApiKeyRequestShape, SubscriptionRequestShape } from './RequestShape'
import { SwitchReading } from './SwitchReading'
import { TierAliases } from './TierAliases'
import type { AliasMap, TierView } from './tier-aliases'
import type {
  CatalogEntry,
  Provider,
  ReasoningEffort,
  SubAccountWire,
  SubscriptionWire,
  Tier,
  TransformerWire
} from './types'

const STATE_LABEL_KEYS: Record<ProviderState, string> = {
  off: 'providers.rail.stateOff',
  live: 'providers.rail.stateLive',
  invalid: 'providers.rail.stateInvalid',
  unknown: 'providers.rail.stateUnknown'
}

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
  accounts: AccountExtrasIndex
  now: number
  /** The tiers as Save would leave them, like `provider` (`tierViewsOf`). */
  tiers: TierView[]
  /** The manual aliases as loaded, which a manual tier's picker offers as current. */
  storedAliases: AliasMap
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
  /** Stage whether this account participates in routing; credentials stay intact. */
  onToggleAccount: (id: string, next: boolean) => void
  /** Point a manual tier's alias at a model; null unsets it. */
  onAlias: (tier: Tier, model: string | null) => void
  /** Per-model reasoning effort; null clears it back to the vendor default. */
  onModelEffort: (model: string, next: ReasoningEffort | null) => void
  onReplaceKey: (key: string) => void
  /** Spend one of the account's banked resets; the screen confirms first. */
  onReauthenticated?: () => Promise<void>
  onUseReset: (account: SubAccountWire) => void
}

export function ProviderDetail(props: ProviderDetailProps) {
  const { provider, subscription, catalogEntry, transformers, quota, now } = props
  const subscriptionMode = provider.auth_mode === 'subscription'
  const rows = buildModelRows(provider, catalogEntry, props.tiers)
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
          <AccountsPanel
            subscription={subscription}
            quota={quota}
            accounts={props.accounts}
            now={now}
            busy={props.busy}
            editing={props.editing}
            onToggle={props.onToggleAccount}
            onUseReset={props.onUseReset}
            onReauthenticated={props.onReauthenticated}
          />
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
      <TierAliases
        views={props.tiers}
        stored={props.storedAliases}
        listed={listedModelsOf(provider)}
        editing={props.editing}
        onPick={props.onAlias}
      />
      {/* Keyed on the provider: the filter, the Show mode and how far the
          list has been expanded are all about THIS provider's models. */}
      <ProviderModelsSection
        key={provider.name}
        provider={provider}
        rows={rows}
        tiers={props.tiers}
        editing={props.editing}
        onToggle={props.onToggleModel}
        onEffort={props.onModelEffort}
        onAlias={props.onAlias}
      />
    </div>
  )
}

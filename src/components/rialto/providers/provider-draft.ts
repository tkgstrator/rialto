/**
 * One provider page's edit, held until Save.
 *
 * The page reads until Edit is pressed. Its alias and effort pickers, its
 * switches and Replace used to write the moment they were touched — one
 * stray click from changing what Routing sends where. Each change lands in
 * a draft instead: the page renders the provider with the draft applied,
 * Revert drops it, and Save writes only what differs from the provider as
 * loaded, so a change made and then undone by hand writes nothing.
 *
 * Pure, so what Save would send can be pinned without a browser.
 */
import { setModelDisabled } from '@/lib/providers/provider-edits'
import { disabledModelsOf, effortOf } from './derive'
import { type AliasChange, type AliasMap, type AliasPicks, aliasChanges } from './tier-aliases'
import type { Provider, ReasoningEffort, SubscriptionWire } from './types'

export interface ProviderDraft {
  /** The provider switch Routing reads, once flipped. */
  enabled?: boolean
  /** Account switches flipped; OAuth credentials are never edited here. */
  accounts: Record<string, boolean>
  /** Model switches flipped, by the value each was flipped to. */
  models: Record<string, boolean>
  /** Reasoning efforts picked; null clears one back to the vendor default. */
  efforts: Record<string, ReasoningEffort | null>
  /** Tier aliases pointed at another model; null unsets one. */
  aliases: AliasPicks
  /** A replacement API key. Empty clears the stored one. */
  apiKey?: string
}

export const EMPTY_DRAFT: ProviderDraft = { accounts: {}, models: {}, efforts: {}, aliases: {} }

/** Keep the account panel's switches aligned with the staged provider edit. */
export function applySubscriptionDraft(subscription: SubscriptionWire | undefined, draft: ProviderDraft | null) {
  if (subscription === undefined || draft === null) return subscription
  return {
    ...subscription,
    accounts: subscription.accounts.map((account) => {
      const enabled = draft.accounts[account.id]
      return enabled === undefined ? account : { ...account, enabled }
    })
  }
}

// The picks laid over a stored map; a null pick removes the entry.
function overlay<V extends string>(
  stored: Record<string, V> | undefined,
  picks: Record<string, V | null>
): Record<string, V> {
  const merged: Record<string, V | null> = { ...stored, ...picks }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, V] => entry[1] !== null))
}

function apiKeyOf(provider: Provider, draft: ProviderDraft): string | null {
  if (draft.apiKey === undefined) return provider.api_key
  return draft.apiKey === '' ? null : draft.apiKey
}

/** The draft's edits to the provider row itself — everything but the aliases. */
function applyRowEdits(provider: Provider, draft: ProviderDraft): Provider {
  const switched = Object.entries(draft.models).reduce(
    (current, [model, on]) => setModelDisabled(current, model, !on),
    provider
  )
  return {
    ...switched,
    enabled: draft.enabled === undefined ? provider.enabled : draft.enabled,
    api_key: apiKeyOf(provider, draft),
    subscription_accounts:
      provider.auth_mode !== 'subscription' || provider.subscription_accounts === undefined
        ? provider.subscription_accounts
        : provider.subscription_accounts.map((account) => {
            const enabled = draft.accounts[account.id]
            return enabled === undefined ? account : { ...account, enabled }
          }),
    modelReasoningEfforts: overlay(provider.modelReasoningEfforts, draft.efforts)
  }
}

/**
 * The provider as Save would leave it, which is what the page renders while editing.
 *
 * A model an alias is newly pointed at reads as switched on, whatever its
 * own switch says: the alias write switches it on, because an alias naming
 * a model that is off resolves to nothing. `stored` is the provider's
 * aliases as loaded — a pick equal to one of them writes nothing, so it
 * switches nothing on either.
 */
export function applyDraft(provider: Provider, draft: ProviderDraft, stored: AliasMap): Provider {
  return aliasChanges(stored, draft.aliases).reduce(
    (current, { model }) => (model === null ? current : setModelDisabled(current, model, false)),
    applyRowEdits(provider, draft)
  )
}

export interface SavePlan {
  /** One provider upsert for provider, model, account switches and the key. */
  upsert: Provider | null
  /** One write per alias that differs from the stored one. */
  aliases: AliasChange[]
  /** One write per effort that differs from the stored one. */
  efforts: Array<{ model: string; effort: ReasoningEffort | null }>
}

const sameMembers = (a: readonly string[], b: readonly string[]): boolean => {
  const inB = new Set(b)
  return new Set(a).size === inB.size && a.every((item) => inB.has(item))
}

/**
 * What Save writes: only what differs from the provider as loaded.
 *
 * The upsert is the loaded row with just the persisted fields a draft changes
 * in it. The draft's efforts stay out of that body on purpose:
 * `POST /api/providers` does not store them, and a body that carried them
 * would read as though it did. So does the switch-on an alias implies —
 * the alias write carries it, and folding it into the upsert would turn a
 * promotion alone into two writes.
 */
export function savePlan(loaded: Provider, draft: ProviderDraft, stored: AliasMap): SavePlan {
  const edited = applyRowEdits(loaded, draft)
  // The server accepts sparse flips. Resending untouched accounts could
  // overwrite a peer's newer choice with the values this page loaded.
  const accounts =
    loaded.auth_mode !== 'subscription' || loaded.subscription_accounts === undefined
      ? []
      : loaded.subscription_accounts.flatMap((account) => {
          const enabled = draft.accounts[account.id]
          return enabled === undefined || enabled === account.enabled ? [] : [{ id: account.id, enabled }]
        })
  const rowChanged =
    edited.enabled !== loaded.enabled ||
    edited.api_key !== loaded.api_key ||
    !sameMembers(disabledModelsOf(edited), disabledModelsOf(loaded)) ||
    accounts.length > 0
  return {
    upsert: rowChanged
      ? {
          ...loaded,
          enabled: edited.enabled,
          api_key: edited.api_key,
          transformer: edited.transformer,
          subscription_accounts: accounts.length === 0 ? undefined : accounts
        }
      : null,
    aliases: aliasChanges(stored, draft.aliases),
    efforts: Object.entries(draft.efforts)
      .filter(([model, effort]) => effortOf(loaded, model) !== effort)
      .map(([model, effort]) => ({ model, effort }))
  }
}

export const hasChanges = (plan: SavePlan): boolean =>
  plan.upsert !== null || plan.aliases.length > 0 || plan.efforts.length > 0

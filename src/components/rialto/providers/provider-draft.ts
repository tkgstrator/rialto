/**
 * One provider page's edit, held until Save.
 *
 * The page reads until Edit is pressed. Its tier and effort pickers, its
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
import type { Provider, ReasoningEffort, Tier } from './types'

export interface ProviderDraft {
  /** The provider switch Routing reads, once flipped. */
  enabled?: boolean
  /** Model switches flipped, by the value each was flipped to. */
  models: Record<string, boolean>
  /** Tier overrides picked; null clears one back to name inference. */
  tiers: Record<string, Tier | null>
  /** Reasoning efforts picked; null clears one back to the vendor default. */
  efforts: Record<string, ReasoningEffort | null>
  /** A replacement API key. Empty clears the stored one. */
  apiKey?: string
}

export const EMPTY_DRAFT: ProviderDraft = { models: {}, tiers: {}, efforts: {} }

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

/** The provider as Save would leave it, which is what the page renders while editing. */
export function applyDraft(provider: Provider, draft: ProviderDraft): Provider {
  const switched = Object.entries(draft.models).reduce(
    (current, [model, on]) => setModelDisabled(current, model, !on),
    provider
  )
  return {
    ...switched,
    enabled: draft.enabled === undefined ? provider.enabled : draft.enabled,
    api_key: apiKeyOf(provider, draft),
    modelManualTiers: overlay(provider.modelManualTiers, draft.tiers),
    modelReasoningEfforts: overlay(provider.modelReasoningEfforts, draft.efforts)
  }
}

export interface SavePlan {
  /** The provider upsert, when its switch, a model switch or the key changed. */
  upsert: Provider | null
  /** One write per tier that differs from the stored override. */
  tiers: Array<{ model: string; tier: Tier | null }>
  /** One write per effort that differs from the stored one. */
  efforts: Array<{ model: string; effort: ReasoningEffort | null }>
}

const manualTierOf = (provider: Provider, model: string): Tier | null => {
  const manual = provider.modelManualTiers === undefined ? undefined : provider.modelManualTiers[model]
  return manual === undefined ? null : manual
}

const sameMembers = (a: readonly string[], b: readonly string[]): boolean => {
  const inB = new Set(b)
  return new Set(a).size === inB.size && a.every((item) => inB.has(item))
}

/**
 * What Save writes: only what differs from the provider as loaded.
 *
 * The upsert is the loaded row with just the three things a draft changes
 * in it. The draft's tiers and efforts stay out of that body on purpose:
 * `POST /api/providers` does not store them, and a body that carried them
 * would read as though it did.
 */
export function savePlan(loaded: Provider, draft: ProviderDraft): SavePlan {
  const edited = applyDraft(loaded, draft)
  const rowChanged =
    edited.enabled !== loaded.enabled ||
    edited.api_key !== loaded.api_key ||
    !sameMembers(disabledModelsOf(edited), disabledModelsOf(loaded))
  return {
    upsert: rowChanged
      ? { ...loaded, enabled: edited.enabled, api_key: edited.api_key, transformer: edited.transformer }
      : null,
    tiers: Object.entries(draft.tiers)
      .filter(([model, tier]) => manualTierOf(loaded, model) !== tier)
      .map(([model, tier]) => ({ model, tier })),
    efforts: Object.entries(draft.efforts)
      .filter(([model, effort]) => effortOf(loaded, model) !== effort)
      .map(([model, effort]) => ({ model, effort }))
  }
}

export const hasChanges = (plan: SavePlan): boolean =>
  plan.upsert !== null || plan.tiers.length > 0 || plan.efforts.length > 0

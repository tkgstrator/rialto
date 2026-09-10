/**
 * Mutations the Providers screens issue.
 *
 * All of them go through `POST /api/providers`, which upserts by name —
 * the PATCH and DELETE verbs on the CRUD routes are not reachable from
 * the browser client, and the full-config round trip is the sanctioned
 * path for a delete (its diff drops the chain entries that named the
 * provider's models and reports them as warnings).
 */
import { api } from '@/lib/api'
import { setModelDisabled } from '@/lib/providers/provider-edits'
import type { SubscriptionRefreshResponse } from '@/schemas/api/subscriptions'
import type { ModelTestResponse, Provider } from './types'

/**
 * Set or clear the per-model tier override the quota-aware selector reads
 * as `manualTier ?? tierOf(name)`. Null falls back to name inference.
 */
export async function setModelTier(
  provider: Provider,
  model: string,
  tier: 'fable' | 'opus' | 'sonnet' | 'haiku' | null
): Promise<void> {
  await api.setModelTier(provider.name, model, tier)
}

/**
 * Set or clear the per-model reasoning effort. Null sends nothing and
 * leaves the vendor default in place, which is not the same as writing
 * that default into every request.
 */
export async function setModelEffort(
  provider: Provider,
  model: string,
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
): Promise<void> {
  await api.setModelReasoningEffort(provider.name, model, effort)
}

/** Flip one model on or off. `_disabledModels` is the wire view of Model.enabled. */
export async function toggleModel(provider: Provider, model: string, next: boolean): Promise<void> {
  await api.post('/providers', setModelDisabled(provider, model, !next))
}

/**
 * Flip the provider itself on or off.
 *
 * This is the flag `enabledTargets` and `getEnabledModels` filter on, so
 * off means Routing stops offering every model underneath it. Until this
 * existed the only writer was the add-provider wizard's last Continue,
 * which left a provider signed in but unroutable with no way back.
 */
export async function toggleProvider(provider: Provider, next: boolean): Promise<void> {
  await api.post('/providers', { ...provider, enabled: next })
}

export async function saveApiKey(provider: Provider, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  await api.post('/providers', { ...provider, api_key: trimmed === '' ? null : trimmed })
}

/**
 * Remove a provider by writing the config back without it. `applyUiConfig`
 * deletes anything the payload no longer lists.
 */
export async function removeProvider(name: string): Promise<void> {
  const config = await api.getConfig()
  await api.updateConfig({ ...config, Providers: config.Providers.filter((p) => p.name !== name) })
}

/**
 * Probe every enabled model, one at a time.
 *
 * There is no provider-scoped batch endpoint — `/api/models/test-all`
 * covers the whole install — and each probe is a real inference call, so
 * serialising them keeps a "Test all" on an 18-model vendor from opening
 * eighteen concurrent upstream requests. A rejected probe is a result,
 * not an error: the outcome is already persisted on the Model row.
 */
export async function testModels(providerName: string, models: string[]): Promise<void> {
  for (const model of models) {
    await api.post<ModelTestResponse>('/models/test', { provider: providerName, model }).catch(() => null)
  }
}

/** Re-read the vendor's model list onto every configured provider. */
export async function syncModels(): Promise<void> {
  await api.post('/refresh-models', {})
}

/** Re-scrape vendor pricing pages, then reflect fresh prices onto provider rows. */
export async function refreshPrices(): Promise<void> {
  await api.post('/catalog/refresh', {})
  await api.post('/refresh-models', {})
}

/**
 * Re-sync every subscription account's profile and poll its usage past the
 * 5-minute cache, so the quota bars describe now rather than the last
 * usage-job tick. Touches no model or price — that is the pair above.
 */
export async function refreshSubscriptions(): Promise<SubscriptionRefreshResponse> {
  return api.post<SubscriptionRefreshResponse>('/subscriptions/refresh', {})
}

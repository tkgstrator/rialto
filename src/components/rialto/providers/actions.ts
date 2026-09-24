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
import type { SavePlan } from './provider-draft'
import type { AliasChange } from './tier-aliases'
import type { ModelTestResponse, Provider, Tier } from './types'

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
 * Switch every listed model on in one write, rather than one POST per
 * currently-disabled model — the add-provider flow lands a subscription
 * vendor with most of its catalog switched off (see `providerFromCatalog`
 * in connect-actions.ts), and toggling each row individually would race:
 * parallel `setModelDisabled` calls each start from the same stale
 * `provider` snapshot, so the last one to land would silently re-disable
 * whatever the others had just cleared.
 */
export async function enableAllModels(provider: Provider): Promise<void> {
  const transformer: Record<string, unknown> = { ...(provider.transformer ? provider.transformer : {}) }
  delete transformer._disabledModels
  await api.post('/providers', { ...provider, transformer })
}

/**
 * Point a provider's tier at a model — promote it — or unset the tier.
 * Pointing also switches the model on, server-side, in the same write.
 */
export async function setTierAlias(provider: Provider, { tier, model }: AliasChange): Promise<void> {
  if (model === null) await api.clearTierAlias(provider.name, tier)
  else await api.setTierAlias(provider.name, tier, model)
}

/** Which write of a staged edit failed, and what the server said about it. */
export interface SaveFailure {
  /** `unalias` is an alias write that unset its tier rather than pointing it. */
  write: 'provider' | 'alias' | 'unalias' | 'effort'
  /** The model an alias or effort write was for; null for the provider's own and for an unset. */
  model: string | null
  /** The tier an alias write was for; null for every other write. */
  tier: Tier | null
  message: string
}

type SaveStep = Omit<SaveFailure, 'message'> & { run: () => Promise<unknown> }

const aliasStep = (provider: Provider, change: AliasChange): SaveStep => ({
  write: change.model === null ? 'unalias' : 'alias',
  model: change.model,
  tier: change.tier,
  run: () => setTierAlias(provider, change)
})

/**
 * Write a provider page's staged edit.
 *
 * The provider upsert goes first: the switch Routing reads (the flag
 * `enabledTargets` and `getEnabledModels` filter on), the model switches
 * and the key all travel in the one body `POST /api/providers` takes.
 * Aliases and efforts are not part of that body, so each one that changed
 * is its own write after it.
 *
 * The aliases follow the upsert rather than precede it because an alias
 * write switches its model on, and the upsert carries every model switch
 * as loaded: run the other way round, the upsert would switch a just
 * promoted model straight back off.
 *
 * Stops at the first write that fails and names it. The writes before it
 * have landed and the ones after it have not, which the screen shows by
 * re-reading rather than by guessing.
 */
export async function saveProviderEdits(provider: Provider, plan: SavePlan): Promise<SaveFailure | null> {
  const upsert = plan.upsert
  const steps: SaveStep[] = [
    ...(upsert === null
      ? []
      : [{ write: 'provider' as const, model: null, tier: null, run: () => api.post('/providers', upsert) }]),
    ...plan.aliases.map((change) => aliasStep(provider, change)),
    ...plan.efforts.map(({ model, effort }) => ({
      write: 'effort' as const,
      model,
      tier: null,
      run: () => setModelEffort(provider, model, effort)
    }))
  ]
  for (const { run, ...which } of steps) {
    try {
      await run()
    } catch (err: unknown) {
      return { ...which, message: err instanceof Error ? err.message : String(err) }
    }
  }
  return null
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

/**
 * Re-scrape the vendors' price pages, then re-read every provider's model
 * list and reflect the fresh prices onto its rows. The screens used to
 * offer these as two buttons, "Refresh prices" and "Sync models", but the
 * second is what makes the first show up: they are one round trip.
 */
export async function refreshCatalog(): Promise<void> {
  await api.post('/catalog/refresh', {})
  await api.post('/refresh-models', {})
}

/**
 * Re-sync subscription accounts' profiles and poll their usage past the
 * 5-minute cache, so the quota bars describe now rather than the last
 * usage-job tick. Every enabled provider's accounts by default; `provider`
 * narrows it to that provider's, switched on or not. Touches no model or
 * price — that is the catalog above.
 */
export async function refreshSubscriptions(provider?: string): Promise<SubscriptionRefreshResponse> {
  return api.post<SubscriptionRefreshResponse>('/subscriptions/refresh', provider === undefined ? {} : { provider })
}

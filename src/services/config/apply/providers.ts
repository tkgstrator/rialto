/**
 * Diff the incoming UI Provider list against DB state: delete removed
 * providers, upsert what remains, and cascade the SubAccount toggle /
 * Model row / enabled-flip reconciliation for each.
 */

import type { Provider } from '@/schemas/domain/provider'
import { AuthMode, type Model as DbModel, type Provider as DbProvider } from '../../../generated/prisma/client'
import { apiStyleForVendor } from '../api-style'
import type { Tx } from '../apply'
import { chainEntryCascadeWarning } from './chain-entries'
import { apiKeyForStorage } from './fields'
import { applyModelEnabledFlips, reconcileModelRows } from './model-rows'
import { applySubscriptionAccountToggles } from './subscription-toggles'

// Delete providers the UI no longer lists. Their models cascade, and so
// do the chain entries naming those models — counted first so the
// operator is told which chains just got shorter.
export async function deleteRemovedProviders(
  tx: Tx,
  existing: ReadonlyArray<DbProvider & { models: DbModel[] }>,
  incomingByName: ReadonlyMap<string, Provider>,
  warnings: string[]
): Promise<void> {
  for (const ex of existing) {
    if (incomingByName.has(ex.name)) continue
    const cascade = await chainEntryCascadeWarning(tx, { providerId: ex.id }, `deleted provider "${ex.name}"`)
    if (cascade !== null) warnings.push(cascade)
    await tx.provider.delete({ where: { id: ex.id } })
  }
}

/**
 * Upsert one Provider row + reconcile its own models / subscription
 * accounts. Owned by both `applyProviders` (the full-config diff path
 * called from `applyUiConfig`) and `upsertProviderRow` (the CRUD
 * single-provider path called from `upsertProvider` in crud.ts).
 *
 * The distinction matters: this helper writes ONLY the incoming
 * provider row. It never looks at other providers, never deletes any
 * row, and never touches another provider's chain entries. That is the cascade
 * that `applyProviders`'s `deleteRemovedProviders` used to eat when the
 * CRUD path passed a single-element array — every other provider (and
 * their subscription accounts via onDelete: Cascade) got wiped on a
 * routine PATCH.
 */
export async function applyProviderRow(
  tx: Tx,
  inc: Provider,
  prevProvider: (DbProvider & { models: DbModel[] }) | undefined,
  warnings: string[]
): Promise<void> {
  const authMode: AuthMode = inc.auth_mode === 'subscription' ? AuthMode.subscription : AuthMode.api_key
  const prevEnabledByName = new Map<string, boolean>(
    prevProvider ? prevProvider.models.map((m) => [m.name, m.enabled]) : []
  )
  const apiKey = apiKeyForStorage(inc.api_key)
  // Provider request shape is derived from the vendor name (single source
  // of truth in apiStyleForVendor). Written on every upsert so newly-
  // created rows don't fall through to the DB default (openai_chat) —
  // that default breaks subscription / anthropic / gemini providers,
  // which route through vendor-specific probes gated on apiStyle.
  const apiStyle = apiStyleForVendor(inc.name)
  const provider = await tx.provider.upsert({
    where: { name: inc.name },
    update: {
      apiBaseUrl: inc.api_base_url,
      apiKey,
      authMode,
      apiStyle,
      enabled: inc.enabled !== false
    },
    create: {
      name: inc.name,
      apiBaseUrl: inc.api_base_url,
      apiKey,
      authMode,
      apiStyle,
      enabled: inc.enabled !== false
    },
    include: { models: true }
  })

  // subscription_accounts only carries enable/disable flips — row
  // creation and deletion is owned by the sync service. We validate
  // ownership per id so a stale UI payload can't toggle some other
  // provider's account.
  await applySubscriptionAccountToggles(tx, provider, inc, warnings)

  await reconcileModelRows(tx, provider, inc, warnings)

  // Write the authoritative Model.enabled column from the UI's
  // _disabledModels selection (must run after reconcileModelRows so
  // the freshly-created rows exist).
  await applyModelEnabledFlips(tx, provider, inc, prevEnabledByName)
}

export async function applyProviders(tx: Tx, incoming: Provider[], warnings: string[]): Promise<void> {
  const existing = await tx.provider.findMany({ include: { models: true } })
  const incomingByName = new Map(incoming.map((p) => [p.name, p]))

  await deleteRemovedProviders(tx, existing, incomingByName, warnings)

  // Upsert what remains.
  for (const inc of incoming) {
    const prevProvider = existing.find((e) => e.name === inc.name)
    await applyProviderRow(tx, inc, prevProvider, warnings)
  }
}

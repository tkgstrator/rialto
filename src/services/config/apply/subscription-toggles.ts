/**
 * Sync incoming subscription_accounts enable/disable toggles onto the
 * SubAccount rows a Provider owns.
 */

import type { Provider } from '@/schemas/domain/provider'
import { AuthMode, type Provider as DbProvider } from '../../../generated/prisma/client'
import type { Tx } from '../apply'

// api_key providers ignore the field entirely; rows the UI doesn't own
// are skipped with a warning.
export async function applySubscriptionAccountToggles(
  tx: Tx,
  provider: DbProvider,
  incoming: Provider,
  warnings: string[]
): Promise<void> {
  if (provider.authMode !== AuthMode.subscription) return
  if (incoming.subscription_accounts === undefined) return
  const ownedRows = await tx.subAccount.findMany({
    where: { providerId: provider.id },
    select: { id: true, enabled: true }
  })
  const currentEnabled = new Map(ownedRows.map((a) => [a.id, a.enabled]))
  const toEnable: string[] = []
  const toDisable: string[] = []
  for (const entry of incoming.subscription_accounts) {
    const current = currentEnabled.get(entry.id)
    if (current === undefined) {
      warnings.push(
        `Subscription account "${entry.id}" does not belong to provider "${provider.name}"; toggle ignored.`
      )
      continue
    }
    if (current === entry.enabled) continue
    if (entry.enabled) toEnable.push(entry.id)
    else toDisable.push(entry.id)
  }
  if (toEnable.length > 0) {
    await tx.subAccount.updateMany({
      where: { id: { in: toEnable } },
      data: { enabled: true }
    })
  }
  if (toDisable.length > 0) {
    await tx.subAccount.updateMany({
      where: { id: { in: toDisable } },
      data: { enabled: false }
    })
  }
}

/**
 * The one Refresh on the Providers screens.
 *
 * It used to be three buttons: "Refresh prices" and "Sync models" for the
 * catalog, and on the Subscriptions list a separate "Refresh" for the
 * accounts. That made the operator decide which reading they doubted
 * before asking for a new one, and the two catalog buttons were halves of
 * the same round trip. One click now asks for everything the screen shows
 * that can age, under one backdrop, and one toast says what came back.
 */
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { SubscriptionRefreshResponse } from '@/schemas/api/subscriptions'
import { refreshCatalog, refreshSubscriptions } from './actions'

/**
 * Which subscription accounts ride along with the catalog: none on the
 * API-key screens, every enabled provider's on the Subscriptions list, and
 * one provider's on its own page — where the server covers the provider
 * even while it is switched off.
 */
export type RefreshScope = { accounts: 'none' } | { accounts: 'all' } | { accounts: 'provider'; provider: string }

interface RefreshOutcome {
  catalog: PromiseSettledResult<void>
  accounts: PromiseSettledResult<SubscriptionRefreshResponse> | null
}

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))

// Side by side rather than in turn: the halves reach different upstreams
// and write different tables, and one failing must not cost the other its
// answer.
async function refreshScope(scope: RefreshScope): Promise<RefreshOutcome> {
  if (scope.accounts === 'none') {
    const [catalog] = await Promise.allSettled([refreshCatalog()])
    return { catalog, accounts: null }
  }
  const [catalog, accounts] = await Promise.allSettled([
    refreshCatalog(),
    refreshSubscriptions(scope.accounts === 'provider' ? scope.provider : undefined)
  ])
  return { catalog, accounts }
}

// Speaks about the accounts when there is more to say than "done", and
// reports whether it did. A failed account is named, not counted: the
// screen shows accounts by label, so "could not refresh anna" points at a
// row where "1 of 3 failed" would not. No accounts at all is said as
// well — where the only subscription provider is switched off, "Refreshed
// usage" would claim a reading nobody took.
function toastAccounts(accounts: PromiseSettledResult<SubscriptionRefreshResponse>, t: TFunction): boolean {
  if (accounts.status === 'rejected') {
    toast.error(messageOf(accounts.reason))
    return true
  }
  const report = accounts.value
  if (report.attempted === 0) {
    toast.info(t('providers.screen.subscriptionsRefreshedNone'))
    return true
  }
  if (report.failed.length === 0) return false
  const message = t('providers.screen.subscriptionsRefreshPartial', {
    refreshed: report.refreshed,
    attempted: report.attempted,
    names: report.failed.map((f) => f.label).join(', ')
  })
  if (report.refreshed === 0) toast.error(message)
  else toast.warning(message)
  return true
}

// A catalog failure is an error of its own, with the server's message: a
// price scrape that never ran looks exactly like one that changed nothing,
// so silence cannot be read as success here.
function narrate(outcome: RefreshOutcome, t: TFunction): void {
  const { catalog, accounts } = outcome
  if (catalog.status === 'rejected') toast.error(messageOf(catalog.reason))
  const accountsSpoke = accounts === null ? false : toastAccounts(accounts, t)
  if (catalog.status === 'rejected' || accountsSpoke) return
  toast.success(t(accounts === null ? 'providers.screen.refreshedCatalog' : 'providers.screen.refreshedAll'))
}

/**
 * The Refresh button's handler, and the backdrop's label while it runs.
 * The toast waits for `reload`, so it lands on a screen already showing
 * what it reports.
 */
export function useRefresh(
  scope: RefreshScope,
  reload: () => Promise<void>
): { pending: string | null; refresh: () => void } {
  const { t } = useTranslation()
  const [pending, setPending] = useState<string | null>(null)
  const refresh = () => {
    setPending(t(scope.accounts === 'none' ? 'providers.screen.refreshingCatalog' : 'providers.screen.refreshingAll'))
    refreshScope(scope)
      .then((outcome) => reload().then(() => narrate(outcome, t)))
      .catch((err: unknown) => toast.error(messageOf(err)))
      .finally(() => setPending(null))
  }
  return { pending, refresh }
}

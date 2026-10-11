import type { AccountQuotaView, QuotaWindowState, RoutingSnapshot } from './types'

// Match the scheduler's three cache TTLs, but check at request time: a
// published snapshot can age without another successful tick.
const MAX_READING_AGE_MS = 3 * 5 * 60_000

const spentNow = (window: QuotaWindowState | null, now: number): window is QuotaWindowState =>
  window !== null &&
  window.limit > 0 &&
  window.used >= window.limit &&
  (window.resetAt === null || window.resetAt > now)

const accountBlock = (account: AccountQuotaView, now: number): { resetAt: number | null } | null => {
  if (account.refreshedAt === null || account.refreshedAt > now || now - account.refreshedAt > MAX_READING_AGE_MS)
    return null
  const hit = [account.fiveHour, account.weekly].filter((window): window is QuotaWindowState => spentNow(window, now))
  if (hit.length === 0) return null
  // Both windows must roll before this account is usable. An unknown reset
  // cannot supply a trustworthy provider-wide Retry-After.
  const resetAt = hit.some((window) => window.resetAt === null)
    ? null
    : Math.max(...hit.flatMap((window) => (window.resetAt === null ? [] : [window.resetAt])))
  return { resetAt }
}

/**
 * Only actual account-wide spent readings can close an entire provider.
 * Unknown/stale accounts keep it open, as do model-scoped weekly limits;
 * a zero-account provider is not evidence of exhaustion.
 */
export function providerExhaustionOf(
  snapshot: RoutingSnapshot | null,
  providerName: string,
  now: number
): { resetAt: number | null } | null {
  if (snapshot === null) return null
  const accounts = snapshot.accounts.filter((account) => account.providerName === providerName)
  if (accounts.length === 0) return null
  const blocks = accounts.map((account) => accountBlock(account, now))
  if (blocks.some((block) => block === null)) return null
  const resets = blocks.flatMap((block) => (block === null || block.resetAt === null ? [] : [block.resetAt]))
  // An account with no known reset may stay blocked beyond every known
  // reset, so do not advertise a precise deadline in that case.
  return { resetAt: resets.length !== blocks.length ? null : Math.min(...resets) }
}

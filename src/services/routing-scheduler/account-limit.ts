/**
 * A spent account-wide window holds the rest of the account's windows —
 * in the scheduler's view of the account, and nowhere else.
 *
 * The account-wide windows — Claude's 5h and 7d, Codex's primary and
 * secondary — each gate every request on the account, whatever the model.
 * Once either is hit the upstream refuses everything, yet it keeps
 * reporting the other windows on their own terms: with the 7d spent the 5h
 * window sits near 0% because nothing can be sent to fill it, and with the
 * 5h spent the 7d and a per-model weekly window (Fable) show only what had
 * been used before the account ran dry. The Fable budget, pace and reset in
 * `quota-math.ts` read only the scoped window, so taken as reported an
 * account that cannot serve a single request kept a Fable budget in the
 * chain, and the chain's Retry-After pointed at a reset that frees nothing.
 *
 * A spent per-model window is not a source: it refuses its own model only,
 * and the account keeps serving the rest.
 *
 * Applied as the tick loads SubAccountQuota, not where usage is fetched.
 * It used to be folded in at the fetch, which wrote the held values into
 * the usage cache, SubAccountUsage, SubAccountQuota and UsageSnapshot, and
 * every panel then drew them as if the vendor had sent them: a 5-hour
 * window resetting in a day, a 7-day window resetting hours before the
 * Fable window that shares its week. What is stored and shown is the
 * vendor's reading; holding the account is a routing decision made on top
 * of it. The account picker needs no such rule — a spent 5h or 7d already
 * binds for every model there (`windowBinds`).
 */

import type { AccountQuotaState, QuotaWindowState } from './types'

type AccountWindows = Pick<AccountQuotaState, 'fiveHour' | 'weekly' | 'scopedFable'>

// Hit at the ceiling itself, not at the account picker's early
// HARD_LIMIT_PCT: until the upstream actually refuses, the other windows
// still describe capacity that is really there.
const spent = (w: QuotaWindowState): boolean => w.limit > 0 && w.used >= w.limit

const resetsLater = (a: number | null, b: number | null): boolean => a !== null && b !== null && a > b

// Until when the account is refused.
interface Block {
  until: number | null
}

// The account stays refused until the LAST of its hit windows resets: with
// both 5h and 7d spent, the 5h rolling over changes nothing. A hit window
// with no reported reset cannot move that point. Null while no
// account-wide window is hit.
const blockOf = (accountWide: readonly (QuotaWindowState | undefined)[]): Block | null => {
  const hit = accountWide.filter((w): w is QuotaWindowState => w !== undefined && spent(w))
  if (hit.length === 0) return null
  return hit.reduce<Block>(
    (block, w) => ({ until: block.until === null || resetsLater(w.resetAt, block.until) ? w.resetAt : block.until }),
    { until: null }
  )
}

// One window as the upstream enforces it while the account is refused:
// spent, and unusable until the block ends. The exception is a window
// spent on its own that resets even later — its reset, not the block's,
// is when it comes back, so its own reading is the truthful one. A window
// the upstream did not report stays unreported: the spent window already
// carries the block.
const underBlock = (own: QuotaWindowState | undefined, block: Block): QuotaWindowState | undefined => {
  if (own === undefined) return undefined
  if (spent(own) && resetsLater(own.resetAt, block.until)) return own
  return { ...own, used: Math.max(own.used, own.limit), resetAt: block.until }
}

export function holdSpentAccount<T extends AccountWindows>(acct: T): T {
  const block = blockOf([acct.fiveHour, acct.weekly])
  if (block === null) return acct
  return {
    ...acct,
    fiveHour: underBlock(acct.fiveHour, block),
    weekly: underBlock(acct.weekly, block),
    scopedFable: underBlock(acct.scopedFable, block)
  }
}

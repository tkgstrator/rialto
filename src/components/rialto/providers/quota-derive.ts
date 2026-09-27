import type { OverviewAccountUsage } from '@/lib/api-types'
import dayjs from '@/lib/dayjs'
import { planCapacityWeight, type SeatKind } from '@/shared/plan-capacity'

export interface AccountQuota {
  /** '5h' or '7d' — the window the percentage and reset belong to. */
  window: string
  /**
   * The per-model weekly rows carry the model's name here; an account's
   * own window carries null. Both arrive as '7d', so this is the only
   * thing that tells "the account's weekly ceiling" from "Fable's share
   * of it".
   */
  scope: string | null
  pct: number
  resetAt: string | null
}

export type QuotaIndex = Map<string, AccountQuota[]>

/**
 * Every window one account is under, shortest first.
 *
 * The panel used to show one — the weekly, because it is the one an
 * operator plans around — and label it "weekly". All of them bind: an
 * account at 0% for the week is still unroutable while its 5-hour window
 * is spent, and the per-model row is the only place a Fable ceiling is
 * visible at all. Showing one made the other two look like they did not
 * exist.
 *
 * Ordered rather than left as the collector emitted it: 5h, then the
 * account's own 7d, then the per-model rows under it. `windowRank` keeps
 * a scoped '7d' behind the account-wide one it is a share of.
 */
const windowRank = (row: AccountQuota): number => {
  if (row.window === '5h') return 0
  return row.scope === null ? 1 : 2
}

export function quotaForAccount(index: QuotaIndex, accountId: string): AccountQuota[] {
  const mine = index.get(accountId)
  if (mine === undefined) return []
  return [...mine].sort((a, b) => {
    const byRank = windowRank(a) - windowRank(b)
    if (byRank !== 0) return byRank
    // Two per-model rows: alphabetical, so the list does not reshuffle
    // between polls.
    return (a.scope === null ? '' : a.scope).localeCompare(b.scope === null ? '' : b.scope)
  })
}

export function indexQuota(
  rows: ReadonlyArray<{ subAccountId: string; windows: readonly AccountQuota[] }>
): QuotaIndex {
  const out: QuotaIndex = new Map()
  // Flattened back out and re-grouped per account: the accounts panel
  // draws every window an account is under, and `providerQuotaPct` folds
  // the same rows into the rail's single number.
  for (const account of rows) {
    for (const row of account.windows) {
      const bucket = out.get(account.subAccountId)
      const entry = { window: row.window, scope: row.scope, pct: row.pct, resetAt: row.resetAt }
      if (bucket === undefined) out.set(account.subAccountId, [entry])
      else bucket.push(entry)
    }
  }
  return out
}

/** '5h', or '7d' / '7d:fable' — one window across every account. */
const windowKey = (row: AccountQuota): string => (row.scope === null ? row.window : `${row.window}:${row.scope}`)

/** What the aggregate needs off an account: which quota rows, and how big a seat. */
export interface QuotaAccount {
  id: string
  plan: string | null
  rateLimitTier: string | null
}

/**
 * Rail-level headroom for a provider, over every account it owns.
 *
 * Combined per window, then the fullest window wins. Not the worst
 * account: accounts fail over to one another, so a provider holding one
 * exhausted account and one untouched one still has budget left, and
 * reporting 100% there calls a healthy provider dead. Windows stay
 * separate from each other because they reset on different clocks — a 5h
 * burst averaged into the week hides both.
 *
 * Seats are weighted by `planCapacityWeight`, the same 1 / 5 / 20 the
 * routing scheduler weights its own pool budget by, because a percentage
 * is a ratio and ratios over different denominators do not average. A
 * spent Max 5x beside a fresh Max 20x is 20% of the pool gone, not half
 * of it — and the column has to agree with the scheduler that is about to
 * route on the same numbers. `kind` rides along because a plan called
 * "pro" is the unit on Claude and a Max-class seat on Codex.
 */
export function providerQuotaPct(index: QuotaIndex, kind: SeatKind, accounts: readonly QuotaAccount[]): number | null {
  const byWindow = new Map<string, { used: number; weight: number }>()
  for (const account of accounts) {
    const rows = index.get(account.id)
    if (rows === undefined) continue
    const weight = planCapacityWeight(kind, account.plan, account.rateLimitTier)
    for (const row of rows) {
      const key = windowKey(row)
      const prev = byWindow.get(key)
      const seat = { used: row.pct * weight, weight }
      if (prev === undefined) byWindow.set(key, seat)
      else byWindow.set(key, { used: prev.used + seat.used, weight: prev.weight + seat.weight })
    }
  }
  // Only the accounts that reported a window are folded into it: an
  // account the collector has not reached yet is unknown, not empty.
  const pcts = [...byWindow.values()].map((w) => Math.round(w.used / w.weight))
  return pcts.length === 0 ? null : Math.max(...pcts)
}

/**
 * What an account carried and what it can still spend, beside its windows.
 *
 * Both come on the same Overview quota row as the windows but are not
 * windows, so they get their own index rather than a place in QuotaIndex:
 * the rail folds QuotaIndex into one percentage, and nothing here belongs
 * in that number.
 */
export interface AccountExtras {
  usage: OverviewAccountUsage | null
  resetCredits: { available: number; applicable: number | null } | null
}

export type AccountExtrasIndex = Map<string, AccountExtras>

export function indexAccountExtras(
  rows: ReadonlyArray<{
    subAccountId: string
    usage: OverviewAccountUsage | null
    resetCredits: { available: number; applicable: number | null } | null
  }>
): AccountExtrasIndex {
  return new Map(rows.map((r) => [r.subAccountId, { usage: r.usage, resetCredits: r.resetCredits }]))
}

/** "Oct 4" in the reader's language, or a dash when the vendor sent no date. */
export function fmtExpiry(iso: string | null, locale: string): string {
  if (iso === null) return '—'
  const at = dayjs(iso)
  if (!at.isValid()) return '—'
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at.toDate())
}

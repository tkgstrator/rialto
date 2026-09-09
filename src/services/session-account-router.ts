/**
 * Routes subscription requests to a specific SubAccount based on the
 * inbound session ID.
 *
 * Decision pipeline (in order):
 *   1. Drop accounts the in-process exhaustion map has marked as
 *      reactively-failed (a recent 429 against that subAccountId).
 *   2. Drop accounts whose DB-recorded rate-limit state shows ANY
 *      always-binding window at or above 100% with `resetAt` still in
 *      the future. For claude that is the overall 7d window, the 7d
 *      Opus window, and the 5h window; for codex it is the primary
 *      window. Any of those at 100% guarantees an upstream 429, so we
 *      pre-empt to a peer account.
 *   3. From the surviving candidates, reuse the sticky-session mapping
 *      if it still points at one of them (prompt-cache continuity).
 *   4. Otherwise pick the account with the HIGHEST required burn rate
 *      across the weekly windows it actually reports:
 *      pctRemaining / timeRemainingMs, taken as the MINIMUM over those
 *      windows. Larger means more unspent quota relative to time until
 *      reset → most at risk of leaving quota on the table, so drain it
 *      first. An account with no usable reading ranks below one that has
 *      a reading and above an exhausted one; ties go to the
 *      least-recently-picked account.
 *
 * If every account is filtered out by steps 1-2, the picker falls back
 * to the full list and returns the least-bad candidate so the request
 * still flows — returning null here would 401 the client, which is
 * strictly worse than letting the request go out and 429.
 *
 * The SubAccountUsage table the picker reads is upserted every 5 min by
 * the BullMQ usage-capture job (`recordPerAccountUsage`), so the DB is
 * the durable source of truth across server restarts and multiple
 * instances. The in-process sticky-session map is best-effort only and
 * is allowed to reset on restart.
 */

import dayjs from '../lib/dayjs'
import { isAccountExhausted } from './failover-state'
import {
  type AccountUsageMap,
  CLAUDE_METRICS,
  CODEX_METRICS,
  getPerAccountUsage,
  isScopedMetric,
  type Metric
} from './subaccount-usage-store'
import { getSubAccountTokensForKind, type SubAccountTokenInfo } from './subscription-account-sync-service'

// sessionId → subAccountId
const sessionMap = new Map<string, string>()

// Always-binding hard-limit windows per kind. Any of these at 100% with
// resetAt still in the future guarantees an upstream 429, so the picker
// must skip the account. Mirrors the constraints upstream actually
// enforces: claude charges the overall 7d, the 7d Opus tier, and the
// 5h rolling window simultaneously; codex enforces the primary window.
const HARD_LIMIT_METRICS: Record<'claude' | 'codex', Metric[]> = {
  claude: [CLAUDE_METRICS.five_hour, CLAUDE_METRICS.seven_day, CLAUDE_METRICS.seven_day_opus],
  codex: [CODEX_METRICS.primary]
}

// The scarce windows each kind balances on once hard limits are out of
// the way. Which keys exist is the vendor's call, not ours: Anthropic
// stopped populating the flat `seven_day_opus` field for most plans and
// now reports per-model weekly limits as `claude.seven_day_scoped.<model>`,
// so pinning one metric key made every account read as "no data" and
// silently disabled the balancing entirely. Match on the shape of the
// metric instead and let each account contribute whichever weekly
// windows it actually has.
//
// The 5h window is deliberately excluded: it is a hard limit (handled
// above), not a resource worth spreading across accounts — its short
// horizon would dominate the burn-rate arithmetic every time.
const isWeeklyMetric = (metric: Metric, kind: 'claude' | 'codex'): boolean => {
  if (kind === 'codex') return metric === CODEX_METRICS.secondary
  return (
    metric === CLAUDE_METRICS.seven_day ||
    metric === CLAUDE_METRICS.seven_day_sonnet ||
    metric === CLAUDE_METRICS.seven_day_opus ||
    isScopedMetric(metric)
  )
}

// Ranking tiers. A single numeric scale cannot express "no reading":
// this used to be `+Infinity`, and because a real burn rate is ~1e-7,
// one account with a missing or stale row outranked every account that
// had real data — permanently, and without even rotating, since the
// reduce below compares with a strict `>`. Tier first, burn rate second
// keeps the unknown case clear of both the healthy and the exhausted.
const TIER_KNOWN = 2
const TIER_UNKNOWN = 1
const TIER_EXHAUSTED = 0

interface AccountRank {
  tier: number
  burnRate: number
}

const UNKNOWN_RANK: AccountRank = { tier: TIER_UNKNOWN, burnRate: 0 }

// subAccountId → when the picker last handed this account out. Ties on
// tier + burn rate go to the least-recently-picked, so a pool of
// equally-ranked accounts rotates instead of sending every request to
// whichever row Postgres happened to return first.
const lastPickedAt = new Map<string, number>()

const pickedAtOf = (subAccountId: string): number => {
  const at = lastPickedAt.get(subAccountId)
  return at === undefined ? 0 : at
}

const remember = (account: SubAccountTokenInfo, now: number): SubAccountTokenInfo => {
  lastPickedAt.set(account.subAccountId, now)
  return account
}

// Whether the account has at least one always-binding window pinned at
// 100% with resetAt still in the future. The "future resetAt" guard is
// what makes a stale DB row self-heal: once the reset passes, the cache
// no longer blocks the account even before the next poller cycle
// rewrites it.
const accountHasHardLimitHit = (usage: AccountUsageMap, kind: 'claude' | 'codex', now: number): boolean => {
  for (const metric of HARD_LIMIT_METRICS[kind]) {
    const w = usage.get(metric)
    if (!w) continue
    if (w.percent < 100) continue
    if (w.resetAt !== null && w.resetAt.valueOf() <= now) continue
    return true
  }
  return false
}

// One window's required burn rate: remaining budget per remaining
// millisecond. Null when the window carries no usable timing — no
// resetAt at all, or a row left stale across its own reset. Null stays
// null all the way up to the tier decision; collapsing it into a number
// is exactly what made a stale row look like the most urgent account in
// the pool.
const burnRateOf = (window: { percent: number; resetAt: Date | null }, now: number): number | null => {
  if (window.resetAt === null) return null
  const timeRemainingMs = window.resetAt.valueOf() - now
  if (timeRemainingMs <= 0) return null
  return Math.max(0, 100 - window.percent) / timeRemainingMs
}

// An account can only spend as fast as its tightest weekly window
// allows, so the minimum burn rate across the windows it reports is the
// honest number: a fresh per-model window must not mask an account-wide
// one sitting at 99%.
const rankAccount = (usage: AccountUsageMap, kind: 'claude' | 'codex', now: number): AccountRank => {
  const rates: number[] = []
  for (const [metric, window] of usage) {
    if (!isWeeklyMetric(metric, kind)) continue
    const rate = burnRateOf(window, now)
    if (rate !== null) rates.push(rate)
  }
  if (rates.length === 0) return UNKNOWN_RANK
  const tightest = Math.min(...rates)
  if (tightest <= 0) return { tier: TIER_EXHAUSTED, burnRate: 0 }
  return { tier: TIER_KNOWN, burnRate: tightest }
}

interface RankedAccount {
  account: SubAccountTokenInfo
  rank: AccountRank
  pickedAt: number
}

const outranks = (a: RankedAccount, b: RankedAccount): boolean => {
  if (a.rank.tier !== b.rank.tier) return a.rank.tier > b.rank.tier
  if (a.rank.burnRate !== b.rank.burnRate) return a.rank.burnRate > b.rank.burnRate
  return a.pickedAt < b.pickedAt
}

// `now` is injectable so unit tests can pin the clock against seeded
// resetAt values without touching real time. Production callers omit
// it and get the actual wall clock.
export async function resolveAccountForSession(
  sessionId: string,
  kind: 'claude' | 'codex',
  now: number = dayjs().valueOf()
): Promise<SubAccountTokenInfo | null> {
  const all = await getSubAccountTokensForKind(kind)
  if (all.length === 0) return null

  // Batch-read the per-account DB state up front so each account's
  // hard-limit check + balancing score consults a coherent snapshot
  // rather than re-querying the DB per account.
  const usageByAcct = await getPerAccountUsage(all.map((a) => a.subAccountId))

  // Drop accounts the reactive 429 path has marked exhausted. The mark
  // auto-evicts past its `until` deadline, so a once-failed account
  // returns to the candidate set automatically when its window resets.
  const notExhausted = all.filter((a) => !isAccountExhausted(a.subAccountId))

  // Drop accounts the DB says have a hard limit hit and a future
  // resetAt — those would 429 if we picked them.
  const usable = notExhausted.filter((a) => {
    const u = usageByAcct.get(a.subAccountId)
    return u !== undefined ? !accountHasHardLimitHit(u, kind, now) : true
  })

  // If both filters dropped every candidate, fall back to the full list
  // so the request still flows (the reactive 429 path will catch the
  // miss). Returning null here would 401 the client, which is strictly
  // worse than letting the request go out.
  const accounts = usable.length > 0 ? usable : notExhausted.length > 0 ? notExhausted : all

  if (accounts.length === 1) return remember(accounts[0], now)

  const cached = sessionMap.get(sessionId)
  if (cached) {
    const found = accounts.find((a) => a.subAccountId === cached)
    if (found) return remember(found, now)
    // Previously-chosen account is no longer in the candidate set (either
    // disabled, reactively-exhausted, or DB-marked hard-limit). Repick —
    // and drop the sticky so a future request doesn't latch back onto the
    // dead choice on a stale read.
    sessionMap.delete(sessionId)
  }

  // Pick the account with the HIGHEST required burn rate across its
  // weekly windows. Rank once up front so the reduce comparison stays
  // O(1) per step and can't see a different snapshot per iteration.
  const ranked = accounts.map((a) => {
    const usage = usageByAcct.get(a.subAccountId)
    const rank = usage === undefined ? UNKNOWN_RANK : rankAccount(usage, kind, now)
    return { account: a, rank, pickedAt: pickedAtOf(a.subAccountId) }
  })
  const picked = ranked.reduce((best, candidate) => (outranks(candidate, best) ? candidate : best)).account
  sessionMap.set(sessionId, picked.subAccountId)
  return remember(picked, now)
}

// Read-only lookup of which account the sticky map currently routes this
// session to. The reactive 429 path uses this to learn the subAccountId
// that just failed (the pipeline picked it deep inside the OAuth
// transformer; there is no other handle on the way back up). Returns
// null when no sticky mapping exists.
export function getActiveAccountForSession(sessionId: string): string | null {
  const cached = sessionMap.get(sessionId)
  return cached !== undefined ? cached : null
}

// Drop the sticky mapping for a session if (and only if) it still points
// at the named account. Called by the reactive 429 path after marking
// the account exhausted so the next retry repicks instead of latching
// back onto the just-failed account. The conditional delete prevents
// racing with a concurrent re-pick that may have already moved the
// sticky onto a different account.
export function releaseAccountForSession(sessionId: string, subAccountId: string): void {
  if (sessionMap.get(sessionId) === subAccountId) sessionMap.delete(sessionId)
}

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
  type Metric,
  scopedMetricModel
} from './subaccount-usage-store'
import { getSubAccountTokensForKind, type SubAccountTokenInfo } from './subscription-account-sync-service'

// sessionId → subAccountId
const sessionMap = new Map<string, string>()

// An account's windows are not all about the same thing, and which ones
// speak for a given request depends on the model it asks for.
//
//   - Account-wide (claude 5h / 7d, codex primary / secondary): bind for
//     every model.
//   - Per-model (claude.seven_day_scoped.<model>, plus the legacy flat
//     seven_day_sonnet / seven_day_opus): bind ONLY for that model.
//     Anthropic meters Fable's weekly allowance separately, so a spent
//     Fable window is no reason to skip an account for a Sonnet call —
//     and, the other way round, a fresh account-wide 7d is no reason to
//     send a Fable call to an account whose Fable window is gone.
//
// Which keys exist is the vendor's call, not ours: Anthropic stopped
// populating the flat `seven_day_opus` field for most plans and now
// reports the per-model limits through `limits[]`. Matching on the shape
// of the metric rather than a pinned key is what keeps that from reading
// as "no data" on every account.
const belongsToKind = (metric: Metric, kind: 'claude' | 'codex'): boolean =>
  kind === 'claude' ? metric.startsWith('claude.') : metric.startsWith('codex.')

// The short rolling window each kind meters alongside the weekly one. It
// gates (a 429 is a 429) but is never balanced on: its horizon is hours,
// so it would dominate the burn-rate arithmetic every time.
const isShortWindow = (metric: Metric, kind: 'claude' | 'codex'): boolean =>
  kind === 'claude' ? metric === CLAUDE_METRICS.five_hour : metric === CODEX_METRICS.primary

// The model slug a per-model window is about, or null when the window is
// account-wide.
const perModelSlugOf = (metric: Metric): string | null => {
  if (metric === CLAUDE_METRICS.seven_day_sonnet) return 'sonnet'
  if (metric === CLAUDE_METRICS.seven_day_opus) return 'opus'
  return scopedMetricModel(metric)
}

// The metric key is a slug of the vendor's `display_name` ("Fable" →
// `fable`) while the request carries an API id ("claude-fable-5-1"), so
// both sides are stripped to alphanumerics before the containment test.
// Same heuristic the routing-scheduler uses in quota-math.ts.
const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')

// Does this window bind for the model the request asks for? An unknown
// model falls back to account-wide windows only: guessing wrong either
// parks a usable account or picks one guaranteed to 429, whereas the
// account-wide windows are never the wrong answer, only an incomplete one.
const windowBinds = (metric: Metric, kind: 'claude' | 'codex', requestedModel: string | undefined): boolean => {
  if (!belongsToKind(metric, kind)) return false
  const slug = perModelSlugOf(metric)
  if (slug === null) return true
  if (requestedModel === undefined) return false
  return squash(requestedModel).includes(squash(slug))
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

// Whether the account has at least one window that binds for THIS
// request pinned at 100% with resetAt still in the future — that
// guarantees an upstream 429, so the picker skips the account. The
// "future resetAt" guard is what makes a stale DB row self-heal: once
// the reset passes, the cache no longer blocks the account even before
// the next poller cycle rewrites it.
const accountHasHardLimitHit = (
  usage: AccountUsageMap,
  kind: 'claude' | 'codex',
  requestedModel: string | undefined,
  now: number
): boolean => {
  for (const [metric, w] of usage) {
    if (!windowBinds(metric, kind, requestedModel)) continue
    if (w.percent < 100) continue
    if (w.resetAt !== null && w.resetAt.valueOf() <= now) continue
    return true
  }
  return false
}

// One window's required burn rate, in **percentage points per hour**:
// how fast the account has to spend to finish this window before it
// resets. Hours rather than the raw milliseconds only because the
// ordering is scale-invariant and %/ms puts every real value at 1e-6 or
// below, which is unreadable the moment one of these lands in a log
// line. Null when the window carries no usable timing — no resetAt at
// all, or a row left stale across its own reset. Null stays null all the
// way up to the tier decision; collapsing it into a number is exactly
// what made a stale row look like the most urgent account in the pool.
const MS_PER_HOUR = 3_600_000

const burnRateOf = (window: { percent: number; resetAt: Date | null }, now: number): number | null => {
  if (window.resetAt === null) return null
  const hoursRemaining = (window.resetAt.valueOf() - now) / MS_PER_HOUR
  if (hoursRemaining <= 0) return null
  return Math.max(0, 100 - window.percent) / hoursRemaining
}

// An account can only spend as fast as its tightest binding weekly
// window allows, so the minimum burn rate across them is the honest
// number: a fresh per-model window must not mask an account-wide one
// sitting at 99%, and a spent one belonging to another model must not
// drag the account down for traffic it would serve fine.
const rankAccount = (
  usage: AccountUsageMap,
  kind: 'claude' | 'codex',
  requestedModel: string | undefined,
  now: number
): AccountRank => {
  const rates: number[] = []
  for (const [metric, window] of usage) {
    if (isShortWindow(metric, kind)) continue
    if (!windowBinds(metric, kind, requestedModel)) continue
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

// `requestedModel` decides which per-model windows bind (see
// `windowBinds`); undefined means the caller could not read a model off
// the request and only account-wide windows are consulted.
//
// `now` is injectable so unit tests can pin the clock against seeded
// resetAt values without touching real time. Production callers omit
// it and get the actual wall clock.
export async function resolveAccountForSession(
  sessionId: string,
  kind: 'claude' | 'codex',
  requestedModel: string | undefined,
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
    return u !== undefined ? !accountHasHardLimitHit(u, kind, requestedModel, now) : true
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
    const rank = usage === undefined ? UNKNOWN_RANK : rankAccount(usage, kind, requestedModel, now)
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

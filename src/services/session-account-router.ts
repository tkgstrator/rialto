/**
 * Routes subscription requests to a specific SubAccount based on the
 * inbound session ID.
 *
 * Decision pipeline (in order):
 *   1. Drop accounts the in-process exhaustion map has marked as
 *      reactively-failed (a recent 429 against that subAccountId).
 *   2. Drop accounts whose DB-recorded rate-limit state shows ANY
 *      binding window at or above `HARD_LIMIT_PCT` with `resetAt` still
 *      in the future — which windows bind is decided per request by
 *      `windowBinds`. Such an account is about to 429, so we pre-empt to
 *      a peer rather than spend a request finding out.
 *   3. From the surviving candidates, reuse the sticky-session mapping
 *      for this request's slot if it still points at one of them
 *      (prompt-cache continuity).
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
 *
 * The sticky is held per SLOT rather than per session, because which
 * accounts are eligible depends on the model (see `windowBinds`) and on
 * the kind. One slot per session made a single Fable call — the one
 * request whose per-model window was spent — repick and then drag the
 * session's Sonnet traffic onto the new account too, even though the
 * original served Sonnet fine; and it made a session that touches both
 * a claude and a codex provider evict its own mapping on every
 * alternation, since the two pools share no accounts.
 */

import dayjs from '../lib/dayjs'
import { tierOf } from '../llms/scenario-router/request-signals'
import { isAccountExhausted } from './failover-state'
import {
  type AccountUsageMap,
  CLAUDE_METRICS,
  CODEX_METRICS,
  getPerAccountUsage,
  type Metric,
  windowBinds
} from './subaccount-usage-store'
import { getSubAccountTokensForKind, type SubAccountTokenInfo } from './subscription-account-sync-service'

// sessionId → (slot → subAccountId). See the header comment for why the
// sticky is slotted rather than one pointer per session.
const sessionMap = new Map<string, Map<string, string>>()

// sessionId → the account most recently handed out for that session, in
// any slot. The reactive 429 path asks "which account did the request
// that just failed use", and the slotted map above cannot answer that on
// its own: the failing request's slot is not a handle the failover path
// has. Kept as a separate map rather than derived so the answer is the
// account actually returned, including on the single-candidate path.
const lastResolved = new Map<string, string>()

// The short rolling window each kind meters alongside the weekly one. It
// gates (a 429 is a 429) but is never balanced on: its horizon is hours,
// so it would dominate the burn-rate arithmetic every time.
const isShortWindow = (metric: Metric, kind: 'claude' | 'codex'): boolean =>
  kind === 'claude' ? metric === CLAUDE_METRICS.five_hour : metric === CODEX_METRICS.primary

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

const remember = (sessionId: string, account: SubAccountTokenInfo, now: number): SubAccountTokenInfo => {
  lastPickedAt.set(account.subAccountId, now)
  lastResolved.set(sessionId, account.subAccountId)
  return account
}

// The sticky slot this request belongs to. Codex meters only
// account-wide windows, so all of its traffic shares one slot; claude's
// per-model weekly windows are metered per tier, which is exactly the
// granularity at which eligibility — and therefore a repick — can
// differ. A model no tier can be read off shares the account-wide slot:
// with no tier there is no per-model window to bind, so it passes the
// same gates as account-wide traffic anyway.
const slotOf = (kind: 'claude' | 'codex', requestedModel: string | undefined): string => {
  if (kind === 'codex') return 'codex'
  const tier = requestedModel === undefined ? undefined : tierOf(requestedModel)
  return tier === undefined ? 'claude' : `claude:${tier}`
}

const setSticky = (sessionId: string, slot: string, subAccountId: string): void => {
  const slots = sessionMap.get(sessionId)
  if (slots === undefined) {
    sessionMap.set(sessionId, new Map([[slot, subAccountId]]))
    return
  }
  slots.set(slot, subAccountId)
}

/**
 * How full a binding window has to be for the account to count as spent.
 *
 * Not 100. The vendor reports `utilization` as a whole number, so 99 is
 * the last reading before the ceiling and an account sitting there will
 * 429 within a handful of requests — every one of which costs a round
 * trip and a failover before the reactive path parks the account. Taking
 * it out a step early buys that back.
 *
 * What it costs is the final percent of the window, which on a weekly
 * allowance is not nothing — and draining the allowance is the whole
 * point of the ranking below. That trade is why this is a named constant
 * rather than a literal in the comparison: it is a policy dial, and the
 * honest reading of a change here is "how much tail quota am I willing
 * to strand to avoid a wasted request".
 */
const HARD_LIMIT_PCT = 99

// Whether the account has at least one window that binds for THIS
// request at or above that mark with resetAt still in the future. The
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
    if (w.percent < HARD_LIMIT_PCT) continue
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

  // A single candidate still goes through the sticky bookkeeping below
  // rather than short-circuiting here. Returning early skipped the write,
  // which left `lastResolved` pointing at whichever account the session
  // used BEFORE the pool narrowed — so a 429 on this request marked the
  // wrong account exhausted and the rotation never moved, and once the
  // pool widened again the stale sticky pulled the session back onto its
  // old account mid-conversation.
  const slot = slotOf(kind, requestedModel)
  const slots = sessionMap.get(sessionId)
  if (slots !== undefined) {
    const cached = slots.get(slot)
    if (cached !== undefined) {
      const found = accounts.find((a) => a.subAccountId === cached)
      if (found) return remember(sessionId, found, now)
      // Previously-chosen account is no longer in the candidate set (either
      // disabled, reactively-exhausted, or DB-marked hard-limit). Repick —
      // and drop the sticky so a future request doesn't latch back onto the
      // dead choice on a stale read. Only THIS slot is dropped: the account
      // may still be the right answer for the session's other models.
      slots.delete(slot)
    }
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
  setSticky(sessionId, slot, picked.subAccountId)
  return remember(sessionId, picked, now)
}

// Read-only lookup of the account this session most recently went out
// on. The reactive 429 path uses this to learn the subAccountId that
// just failed (the pipeline picked it deep inside the OAuth transformer;
// there is no other handle on the way back up). Returns null when the
// session has not resolved an account yet.
export function getActiveAccountForSession(sessionId: string): string | null {
  const resolved = lastResolved.get(sessionId)
  return resolved !== undefined ? resolved : null
}

// Drop the session's pointers to the named account if (and only if) they
// still point at it. Called by the reactive 429 path after marking the
// account exhausted so the next retry repicks instead of latching back
// onto the just-failed account. The conditional delete prevents racing
// with a concurrent re-pick that may have already moved on.
//
// Every slot holding the account goes, not just the failing request's:
// `markAccountExhausted` has already taken it out of the candidate set
// for all of them, so leaving the entries behind would only park stale
// pointers until each slot next repicks.
export function releaseAccountForSession(sessionId: string, subAccountId: string): void {
  if (lastResolved.get(sessionId) === subAccountId) lastResolved.delete(sessionId)
  const slots = sessionMap.get(sessionId)
  if (slots === undefined) return
  for (const [slot, id] of slots) {
    if (id === subAccountId) slots.delete(slot)
  }
  if (slots.size === 0) sessionMap.delete(sessionId)
}

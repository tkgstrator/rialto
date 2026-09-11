/**
 * Account-quota arithmetic for the routing scheduler.
 *
 * Split from `compute.ts` because everything here reads only the quota
 * windows hanging off `AccountQuotaState` — used/limit counters, reset
 * timestamps, staleness — and knows nothing about preference rank,
 * normalisation or the guards. That boundary is what makes the Fable
 * special case containable: `isFableTarget` and the scoped-window
 * fallback appear in three functions below and nowhere else in the
 * scheduler.
 */

import type { AccountQuotaState, ModelCandidateState } from './types'

const STALE_MULTIPLIER = 3 // "stale" when refreshedAt older than 3 * ttlMs

// One window's remaining budget as a 0..1 ratio. Any missing / invalid
// pair collapses to null so `budgetOf` can decide whether to treat the
// account as unknown-budget.
const remainingRatio = (window: { used: number; limit: number }): number | null => {
  if (window.limit <= 0) return null
  const r = 1 - window.used / window.limit
  if (Number.isNaN(r)) return null
  return Math.max(0, Math.min(1, r))
}

// Budget for one account: min across every binding window. A null
// window is treated as "no data" and doesn't participate in the min
// (an account with only a 5h reading and no weekly still ranks on
// the 5h remaining).
const accountBudget = (acct: AccountQuotaState): number | null => {
  const five = acct.fiveHour === undefined ? null : remainingRatio(acct.fiveHour)
  const week = acct.weekly === undefined ? null : remainingRatio(acct.weekly)
  if (five === null && week === null) return null
  if (five === null) return week
  if (week === null) return five
  return Math.min(five, week)
}

// Fable has its own weekly rate limit that Anthropic reports separately
// (`weekly_scoped[fable]`), independent of the account-wide 5h / weekly
// counters that gate Claude Code as a whole. For Fable candidates, that
// scoped window IS the budget — the account-wide limits belong to Opus /
// Sonnet traffic, and mixing them would demote Fable every time regular
// Claude Code usage climbed. A 5h or weekly window that is actually spent
// still reaches Fable: the tick holds the scoped window with it as it loads
// the account (`account-limit.ts`). Falls back to `accountBudget` when the
// upstream hasn't reported a scoped window yet (fresh account, non-Fable
// plan), so the pipeline still yields a working number.
const isFableTarget = (candidate: ModelCandidateState): boolean => candidate.modelName.toLowerCase().includes('fable')

const accountBudgetFor = (acct: AccountQuotaState, useScopedFable: boolean): number | null => {
  if (useScopedFable && acct.scopedFable !== undefined) return remainingRatio(acct.scopedFable)
  return accountBudget(acct)
}

const accountStale = (acct: AccountQuotaState, now: number, ttlMs: number): boolean => {
  if (acct.refreshedAt === null) return false // cold-start = not stale (see unknown handling)
  return now - acct.refreshedAt > STALE_MULTIPLIER * ttlMs
}

const accountKnown = (acct: AccountQuotaState): boolean => acct.fiveHour !== undefined || acct.weekly !== undefined

// Aggregate budget for a candidate model: capacity-weighted average of
// each usable account's remaining ratio. session-account-router picks
// the account with the highest required burn-rate (drain-first), not
// max-headroom, so a Fable-scoped 100% account cannot mask a same-plan
// 0% peer — the pool's true remaining is the average, and weighting by
// plan capacity (Pro=1 / Max=5 / Max20=20) keeps a large exhausted
// account from being washed out by a tiny full one. Returns { value,
// unknownAccounts, staleAccounts } so `computeWeights` can attach
// reasons.
export interface BudgetView {
  value: number | null
  unknownAccounts: number
  staleAccounts: number
}

export const modelBudget = (candidate: ModelCandidateState, now: number, ttlMs: number): BudgetView => {
  const useScopedFable = isFableTarget(candidate)
  let weightedSum = 0
  let weightTotal = 0
  let unknownAccounts = 0
  let staleAccounts = 0
  for (const acct of candidate.accounts) {
    if (!accountKnown(acct)) {
      unknownAccounts += 1
      continue
    }
    if (accountStale(acct, now, ttlMs)) {
      staleAccounts += 1
      continue
    }
    const b = accountBudgetFor(acct, useScopedFable)
    if (b === null) {
      unknownAccounts += 1
      continue
    }
    const w = acct.planWeight > 0 ? acct.planWeight : 1
    weightedSum += b * w
    weightTotal += w
  }
  const value = weightTotal > 0 ? weightedSum / weightTotal : null
  return { value, unknownAccounts, staleAccounts }
}

// Earliest resetAt across the candidate's accounts (used for the
// resetSoon downweight). Null when no reset is known.
export const earliestReset = (candidate: ModelCandidateState): number | null => {
  const useScopedFable = isFableTarget(candidate)
  let earliest: number | null = null
  for (const acct of candidate.accounts) {
    const cands: (number | null)[] =
      useScopedFable && acct.scopedFable !== undefined
        ? [acct.scopedFable.resetAt]
        : [acct.fiveHour?.resetAt ?? null, acct.weekly?.resetAt ?? null]
    for (const c of cands) {
      if (c === null) continue
      if (earliest === null || c < earliest) earliest = c
    }
  }
  return earliest
}
// paceRatio for a single window: consumed% / elapsed%. Returns null when
// any input is missing or the elapsed fraction is too small to be
// meaningful (< 1% — one request out of the gate would otherwise look
// like a 100x pace). The tightest of a candidate's windows dominates
// so `windowPace` is called per window and the caller takes the max.
interface WindowPace {
  paceRatio: number
  elapsedRatio: number
}
const windowPace = (
  window: { used: number; limit: number; resetAt: number | null; windowLengthMs: number | null },
  now: number
): WindowPace | null => {
  if (window.limit <= 0) return null
  if (window.resetAt === null || window.windowLengthMs === null) return null
  if (window.windowLengthMs <= 0) return null
  const startedAt = window.resetAt - window.windowLengthMs
  const elapsedMs = now - startedAt
  if (elapsedMs <= 0) return null
  const elapsedRatio = Math.min(1, elapsedMs / window.windowLengthMs)
  if (elapsedRatio < 0.01) return null
  const consumedRatio = window.used / window.limit
  return { paceRatio: consumedRatio / elapsedRatio, elapsedRatio }
}

// Candidate-level pace: aggregate min-elapsed max-pace across the
// candidate's usable accounts and their windows. Min-elapsed captures
// the earliest active window so the caller's "we're only 5% into the
// window" guard fires when needed. Max-paceRatio captures the tightest
// binding window so an underused weekly doesn't mask a burning 5h.
export interface CandidatePace {
  paceRatio: number | null
  windowElapsedRatio: number | null
}
export const candidatePace = (candidate: ModelCandidateState, now: number, ttlMs: number): CandidatePace => {
  const useScopedFable = isFableTarget(candidate)
  let worstPace: number | null = null
  let earliestElapsed: number | null = null
  for (const acct of candidate.accounts) {
    if (!accountKnown(acct)) continue
    if (accountStale(acct, now, ttlMs)) continue
    const paces: (WindowPace | null)[] =
      useScopedFable && acct.scopedFable !== undefined
        ? [windowPace(acct.scopedFable, now)]
        : [
            acct.fiveHour === undefined ? null : windowPace(acct.fiveHour, now),
            acct.weekly === undefined ? null : windowPace(acct.weekly, now)
          ]
    for (const wp of paces) {
      if (wp === null) continue
      if (worstPace === null || wp.paceRatio > worstPace) worstPace = wp.paceRatio
      if (earliestElapsed === null || wp.elapsedRatio < earliestElapsed) earliestElapsed = wp.elapsedRatio
    }
  }
  return { paceRatio: worstPace, windowElapsedRatio: earliestElapsed }
}

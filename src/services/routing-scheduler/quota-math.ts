/**
 * Account-quota arithmetic for the routing scheduler.
 *
 * Everything here reads only the quota windows hanging off
 * `AccountQuotaState` — used/limit counters, reset timestamps,
 * staleness. That boundary is what makes the Fable special case
 * containable: `isFableTarget` and the scoped-window fallback appear in
 * the functions below and nowhere else in the scheduler.
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
// account from being washed out by a tiny full one. Unknown and stale
// accounts are counted rather than averaged, so the caller can tell "no
// budget left" from "no reading to go on".
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

// Earliest resetAt across the candidate's accounts. For an exhausted
// target this is when it can serve again: `holdSpentAccount` has already
// moved every window of a refused account to the reset that frees it.
// Null when no reset is known.
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

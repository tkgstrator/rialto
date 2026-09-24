/**
 * Target quota state: what one "provider,model" has left, from the
 * accounts behind it. Pure — the tick loads the accounts, this reads
 * them.
 */

import { earliestReset, modelBudget } from './quota-math'
import type { ModelCandidateState, TargetQuotaState } from './types'

export function targetQuotaOf(candidate: ModelCandidateState, now: number, ttlMs: number): TargetQuotaState {
  const budget = modelBudget(candidate, now, ttlMs)
  // An account the collector cannot vouch for could still serve, so it
  // keeps the target open: holding a whole target on a reading that is
  // missing or old would refuse traffic the upstream would take.
  const everyAccountRead = budget.unknownAccounts === 0 && budget.staleAccounts === 0
  return {
    target: candidate.target,
    exhausted: everyAccountRead && budget.value !== null && budget.value <= 0,
    remainingBudgetPct: budget.value === null ? null : Math.round(budget.value * 1000) / 10,
    resetAt: earliestReset(candidate)
  }
}

// The Retry-After source when a whole tier is out: the first exhausted
// target to come back.
export function soonestResetOf(targets: Iterable<TargetQuotaState>): number | null {
  const resets = [...targets].flatMap((t) => (t.exhausted && t.resetAt !== null ? [t.resetAt] : []))
  return resets.length === 0 ? null : Math.min(...resets)
}

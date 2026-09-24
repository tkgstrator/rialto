/**
 * Where a target lands at its quota reset if use keeps its current pace.
 *
 * The router steps a route down when this says it will run out and pulls
 * it forward when it says quota will be left over, so a wrong reading
 * moves traffic. Pinned: the pace formula, the 10% warm-up, the tightest
 * window per account, Fable's own window, and the capacity weighting.
 */

import { describe, expect, test } from 'bun:test'
import { PACE_MIN_ELAPSED, projectedUsage } from '../../../src/services/routing-scheduler/quota-math'
import type {
  AccountQuotaState,
  ModelCandidateState,
  QuotaWindowState
} from '../../../src/services/routing-scheduler/types'

const NOW = 1_800_000_000_000
const TTL = 5 * 60_000
const HOUR = 3_600_000
const WEEK = 168 * HOUR

// A window `elapsed` of the way through, `used` percent spent.
const win = (used: number, elapsed: number, length = WEEK): QuotaWindowState => ({
  used,
  limit: 100,
  resetAt: NOW + (1 - elapsed) * length,
  windowLengthMs: length
})

const account = (over: Partial<AccountQuotaState> = {}): AccountQuotaState => ({
  subAccountId: 'a1',
  kind: 'claude',
  providerName: 'claude-code',
  fiveHour: undefined,
  weekly: win(50, 0.5),
  scopedFable: undefined,
  planWeight: 1,
  refreshedAt: NOW - 60_000,
  ...over
})

const target = (accounts: AccountQuotaState[], modelName = 'claude-sonnet-5'): ModelCandidateState => ({
  target: `claude-code,${modelName}`,
  providerName: 'claude-code',
  modelName,
  accounts
})

describe('projectedUsage', () => {
  test('half spent half way through is on course to be exactly spent', () => {
    expect(projectedUsage(target([account()]), NOW, TTL)).toBeCloseTo(1, 6)
  })

  test('30% spent 60% of the way through ends at half the budget', () => {
    expect(projectedUsage(target([account({ weekly: win(30, 0.6) })]), NOW, TTL)).toBeCloseTo(0.5, 6)
  })

  test('too early in the window to judge reads as unknown', () => {
    const early = account({ weekly: win(5, PACE_MIN_ELAPSED / 2) })
    expect(projectedUsage(target([early]), NOW, TTL)).toBeNull()
  })

  test('the tightest window binds: a burning 5h window outweighs an easy week', () => {
    const acct = account({ fiveHour: win(80, 0.4, 5 * HOUR), weekly: win(20, 0.5) })
    expect(projectedUsage(target([acct]), NOW, TTL)).toBeCloseTo(2, 6)
  })

  test("Fable is judged on its own weekly window, not the account's", () => {
    const acct = account({ weekly: win(90, 0.5), scopedFable: win(10, 0.5) })
    expect(projectedUsage(target([acct], 'claude-fable-5'), NOW, TTL)).toBeCloseTo(0.2, 6)
    expect(projectedUsage(target([acct], 'claude-sonnet-5'), NOW, TTL)).toBeCloseTo(1.8, 6)
  })

  test('accounts are weighted by plan capacity: a Max20 counts twenty times a Pro', () => {
    const pro = account({ subAccountId: 'pro', weekly: win(100, 0.5), planWeight: 1 })
    const max20 = account({ subAccountId: 'max', weekly: win(10, 0.5), planWeight: 20 })
    expect(projectedUsage(target([pro, max20]), NOW, TTL)).toBeCloseTo((2 * 1 + 0.2 * 20) / 21, 6)
  })

  test('accounts with no reading, or a stale one, are left out rather than read as idle', () => {
    const cold = account({ subAccountId: 'cold', weekly: undefined, refreshedAt: null })
    const stale = account({ subAccountId: 'stale', weekly: win(0, 0.5), refreshedAt: NOW - 4 * TTL })
    expect(projectedUsage(target([account(), cold, stale]), NOW, TTL)).toBeCloseTo(1, 6)
    expect(projectedUsage(target([cold, stale]), NOW, TTL)).toBeNull()
  })
})

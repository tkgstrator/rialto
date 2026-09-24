/**
 * What the quota snapshot says about one target.
 *
 * `exhausted` is the only reading the tier router holds a route on
 * outright, so it has to mean "every account behind this model reads as
 * spent right now" and nothing weaker: an account the collector cannot
 * vouch for — never polled, or its reading gone stale — could still
 * serve, and holding the whole target on it would refuse traffic the
 * upstream would take.
 */

import { describe, expect, test } from 'bun:test'
import { soonestResetOf, targetQuotaOf } from '../../../src/services/routing-scheduler/targets'
import type {
  AccountQuotaState,
  ModelCandidateState,
  TargetQuotaState
} from '../../../src/services/routing-scheduler/types'

const NOW = 1_800_000_000_000
const TTL = 5 * 60_000
const HOUR = 3_600_000

const account = (over: Partial<AccountQuotaState> = {}): AccountQuotaState => ({
  subAccountId: 'a1',
  kind: 'claude',
  providerName: 'claude-code',
  fiveHour: { used: 30, limit: 100, resetAt: NOW + HOUR, windowLengthMs: 5 * HOUR },
  weekly: { used: 50, limit: 100, resetAt: NOW + 48 * HOUR, windowLengthMs: 168 * HOUR },
  scopedFable: undefined,
  planWeight: 1,
  refreshedAt: NOW - 60_000,
  ...over
})

const spent = { used: 100, limit: 100, resetAt: NOW + 2 * HOUR, windowLengthMs: 5 * HOUR }

const candidate = (accounts: AccountQuotaState[], modelName = 'claude-sonnet-5'): ModelCandidateState => ({
  target: `claude-code,${modelName}`,
  providerName: 'claude-code',
  modelName,
  accounts
})

describe('targetQuotaOf', () => {
  test('a target with budget left is open, and says how much', () => {
    const out = targetQuotaOf(candidate([account()]), NOW, TTL)
    expect(out.exhausted).toBe(false)
    // The tighter of 5h (70% left) and weekly (50% left).
    expect(out.remainingBudgetPct).toBe(50)
  })

  test('every account spent: exhausted, back when the first of them resets', () => {
    const out = targetQuotaOf(
      candidate([
        account({ subAccountId: 'a1', fiveHour: spent }),
        account({ subAccountId: 'a2', fiveHour: { ...spent, resetAt: NOW + HOUR } })
      ]),
      NOW,
      TTL
    )
    expect(out.exhausted).toBe(true)
    expect(out.remainingBudgetPct).toBe(0)
    expect(out.resetAt).toBe(NOW + HOUR)
  })

  test('one account spent and one with room: open — the account picker rotates onto the other', () => {
    const out = targetQuotaOf(candidate([account({ fiveHour: spent }), account({ subAccountId: 'a2' })]), NOW, TTL)
    expect(out.exhausted).toBe(false)
  })

  test('a spent account beside one never polled stays open', () => {
    const cold = account({ subAccountId: 'a2', fiveHour: undefined, weekly: undefined, refreshedAt: null })
    const out = targetQuotaOf(candidate([account({ fiveHour: spent }), cold]), NOW, TTL)
    expect(out.exhausted).toBe(false)
  })

  test('a spent reading that has gone stale does not hold the target', () => {
    const out = targetQuotaOf(candidate([account({ fiveHour: spent, refreshedAt: NOW - 4 * TTL })]), NOW, TTL)
    expect(out.exhausted).toBe(false)
    expect(out.remainingBudgetPct).toBeNull()
  })

  test('no accounts at all: unknown, not exhausted', () => {
    const out = targetQuotaOf(candidate([]), NOW, TTL)
    expect(out).toEqual({
      target: 'claude-code,claude-sonnet-5',
      exhausted: false,
      remainingBudgetPct: null,
      resetAt: null
    })
  })

  test("Fable reads its own weekly window, so a spent one holds Fable and leaves Sonnet's budget alone", () => {
    const acct = account({ scopedFable: { ...spent, resetAt: NOW + 72 * HOUR, windowLengthMs: 168 * HOUR } })
    expect(targetQuotaOf(candidate([acct], 'claude-fable-5'), NOW, TTL).exhausted).toBe(true)
    expect(targetQuotaOf(candidate([acct], 'claude-sonnet-5'), NOW, TTL).exhausted).toBe(false)
  })
})

describe('soonestResetOf', () => {
  const state = (target: string, exhausted: boolean, resetAt: number | null): TargetQuotaState => ({
    target,
    exhausted,
    remainingBudgetPct: exhausted ? 0 : 40,
    resetAt
  })

  test('the earliest reset among exhausted targets only', () => {
    expect(
      soonestResetOf([
        state('a,x', true, NOW + 3 * HOUR),
        state('b,y', false, NOW + HOUR),
        state('c,z', true, NOW + 2 * HOUR)
      ])
    ).toBe(NOW + 2 * HOUR)
  })

  test('null when nothing is exhausted', () => {
    expect(soonestResetOf([state('a,x', false, NOW + HOUR)])).toBeNull()
  })
})

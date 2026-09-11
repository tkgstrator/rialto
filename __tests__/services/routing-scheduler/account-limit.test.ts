/**
 * A spent account-wide window held over the account's other windows, in
 * the scheduler's view only.
 *
 * The default fixture is the shape a real account reported: 7d at 100%
 * while its 5h window read 0% with no reset and its Fable window 9%. Both
 * have to read as spent until the weekly resets, or the chain keeps a
 * Fable budget on an account that refuses every request. A spent 5h window
 * refuses the account the same way, only until an earlier reset.
 *
 * That the fetch itself stores the vendor's reading is pinned in
 * `usage-fetch-force.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { holdSpentAccount } from '../../../src/services/routing-scheduler/account-limit'
import type { AccountQuotaState, QuotaWindowState } from '../../../src/services/routing-scheduler/types'

type Windows = Pick<AccountQuotaState, 'fiveHour' | 'weekly' | 'scopedFable'>

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FIVE_HOUR_RESET = Date.parse('2026-09-11T03:00:00.000Z')
const WEEKLY_RESET = Date.parse('2026-09-12T15:00:00.000Z')

const fiveHour = (used: number, resetAt: number | null): QuotaWindowState => ({
  used,
  limit: 100,
  resetAt,
  windowLengthMs: FIVE_HOUR_MS
})
const weekly = (used: number, resetAt: number | null): QuotaWindowState => ({
  used,
  limit: 100,
  resetAt,
  windowLengthMs: WEEK_MS
})

const account = (overrides: Partial<Windows>): Windows => ({
  fiveHour: fiveHour(0, null),
  weekly: weekly(100, WEEKLY_RESET),
  scopedFable: weekly(9, WEEKLY_RESET),
  ...overrides
})

describe('holdSpentAccount', () => {
  test('a spent 7d holds the 5h and Fable windows as spent until the weekly resets', () => {
    const held = holdSpentAccount(account({}))
    expect(held.fiveHour).toEqual(fiveHour(100, WEEKLY_RESET))
    expect(held.weekly).toEqual(weekly(100, WEEKLY_RESET))
    expect(held.scopedFable).toEqual(weekly(100, WEEKLY_RESET))
  })

  test('a spent 5h holds the 7d and Fable windows as spent until the 5h resets', () => {
    const held = holdSpentAccount(
      account({ fiveHour: fiveHour(100, FIVE_HOUR_RESET), weekly: weekly(40, WEEKLY_RESET) })
    )
    expect(held.fiveHour).toEqual(fiveHour(100, FIVE_HOUR_RESET))
    expect(held.weekly).toEqual(weekly(100, FIVE_HOUR_RESET))
    expect(held.scopedFable).toEqual(weekly(100, FIVE_HOUR_RESET))
  })

  test('with both spent, every window is held until the later reset', () => {
    const held = holdSpentAccount(account({ fiveHour: fiveHour(100, FIVE_HOUR_RESET) }))
    expect(held.fiveHour).toEqual(fiveHour(100, WEEKLY_RESET))
    expect(held.weekly).toEqual(weekly(100, WEEKLY_RESET))
    expect(held.scopedFable).toEqual(weekly(100, WEEKLY_RESET))
  })

  test('a spent Fable window refuses only Fable, so the account stays as reported', () => {
    const acct = account({
      fiveHour: fiveHour(10, FIVE_HOUR_RESET),
      weekly: weekly(40, WEEKLY_RESET),
      scopedFable: weekly(100, WEEKLY_RESET)
    })
    expect(holdSpentAccount(acct)).toEqual(acct)
  })

  test('below the ceiling nothing changes — 99% is not a refusal yet', () => {
    const acct = account({ fiveHour: fiveHour(99, FIVE_HOUR_RESET), weekly: weekly(99, WEEKLY_RESET) })
    expect(holdSpentAccount(acct)).toEqual(acct)
  })

  test('a Fable window spent on its own that resets after the block keeps its own reset', () => {
    // The shape the Usage panel showed as "7-day 3h 20m / Fable 5d 14h"
    // while the fold still ran at the fetch: 5h spent, weekly not, Fable
    // spent on the same week as the weekly.
    const held = holdSpentAccount(
      account({
        fiveHour: fiveHour(100, FIVE_HOUR_RESET),
        weekly: weekly(80, WEEKLY_RESET),
        scopedFable: weekly(100, WEEKLY_RESET)
      })
    )
    expect(held.weekly).toEqual(weekly(100, FIVE_HOUR_RESET))
    expect(held.scopedFable).toEqual(weekly(100, WEEKLY_RESET))
  })

  test('a window the upstream did not report is not invented', () => {
    const held = holdSpentAccount(account({ fiveHour: undefined, scopedFable: undefined }))
    expect(held.fiveHour).toBeUndefined()
    expect(held.scopedFable).toBeUndefined()
  })

  test('the rest of the account state passes through untouched', () => {
    const acct: AccountQuotaState = {
      subAccountId: 'acct-codex',
      kind: 'codex',
      providerName: 'codex',
      // Codex's primary / secondary land in the same two slots.
      fiveHour: fiveHour(12, FIVE_HOUR_RESET),
      weekly: weekly(100, WEEKLY_RESET),
      scopedFable: undefined,
      planWeight: 20,
      refreshedAt: 1
    }
    expect(holdSpentAccount(acct)).toEqual({ ...acct, fiveHour: fiveHour(100, WEEKLY_RESET) })
  })
})

/**
 * A spent account-wide window folded into the account's other windows.
 *
 * The default fixture is the shape a real account reported: 7d at 100%
 * while its 5h window read 0% with no reset and its Fable window 9%. Both
 * have to read as spent until the weekly resets, or the scheduler keeps a
 * Fable budget on an account that refuses every request. A spent 5h window
 * refuses the account the same way, only until an earlier reset.
 */

import { describe, expect, test } from 'bun:test'
import type { ClaudeUsage, CodexUsage } from '../../src/schemas/api/usage'
import { applyClaudeAccountLimit, applyCodexAccountLimit } from '../../src/services/usage-service/account-limit'

const FIVE_HOUR_RESET = '2026-09-11T03:00:00.000Z'
const WEEKLY_RESET = '2026-09-12T15:00:00.235652+00:00'

const claude = (overrides: Partial<ClaudeUsage>): ClaudeUsage => ({
  subAccountId: 'acct-claude',
  accountLabel: 'anna',
  fiveHour: { utilization: 0, resetsAt: null },
  sevenDay: { utilization: 100, resetsAt: WEEKLY_RESET },
  sevenDaySonnet: null,
  sevenDayOpus: null,
  weeklyScoped: [{ modelName: 'Fable', utilization: 9, resetsAt: WEEKLY_RESET }],
  extraUsageEnabled: false,
  capturedAt: '2026-09-11T00:00:00.000Z',
  ...overrides
})

describe('applyClaudeAccountLimit', () => {
  test('a spent 7d reads the 5h and per-model windows as spent until the weekly resets', () => {
    const folded = applyClaudeAccountLimit(claude({}))
    expect(folded.fiveHour).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
    expect(folded.weeklyScoped).toEqual([{ modelName: 'Fable', utilization: 100, resetsAt: WEEKLY_RESET }])
    expect(folded.sevenDay).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
  })

  test('a spent 5h reads the 7d and per-model windows as spent until the 5h resets', () => {
    const folded = applyClaudeAccountLimit(
      claude({
        fiveHour: { utilization: 100, resetsAt: FIVE_HOUR_RESET },
        sevenDay: { utilization: 40, resetsAt: WEEKLY_RESET }
      })
    )
    expect(folded.sevenDay).toEqual({ utilization: 100, resetsAt: FIVE_HOUR_RESET })
    expect(folded.weeklyScoped).toEqual([{ modelName: 'Fable', utilization: 100, resetsAt: FIVE_HOUR_RESET }])
    expect(folded.fiveHour).toEqual({ utilization: 100, resetsAt: FIVE_HOUR_RESET })
  })

  test('with both spent, every window is held until the later reset', () => {
    const folded = applyClaudeAccountLimit(claude({ fiveHour: { utilization: 100, resetsAt: FIVE_HOUR_RESET } }))
    expect(folded.fiveHour).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
    expect(folded.sevenDay).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
    expect(folded.weeklyScoped).toEqual([{ modelName: 'Fable', utilization: 100, resetsAt: WEEKLY_RESET }])
  })

  test('the legacy flat Sonnet / Opus windows are per-model windows too', () => {
    const folded = applyClaudeAccountLimit(
      claude({
        sevenDaySonnet: { utilization: 40, resetsAt: '2026-09-14T00:00:00.000Z' },
        sevenDayOpus: { utilization: 3, resetsAt: null }
      })
    )
    expect(folded.sevenDaySonnet).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
    expect(folded.sevenDayOpus).toEqual({ utilization: 100, resetsAt: WEEKLY_RESET })
  })

  test('a spent per-model window refuses only its own model, so the account stays as reported', () => {
    const usage = claude({
      fiveHour: { utilization: 10, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { utilization: 40, resetsAt: WEEKLY_RESET },
      weeklyScoped: [{ modelName: 'Fable', utilization: 100, resetsAt: WEEKLY_RESET }]
    })
    expect(applyClaudeAccountLimit(usage)).toEqual(usage)
  })

  test('below the ceiling nothing changes — 99% is not a refusal yet', () => {
    const usage = claude({
      fiveHour: { utilization: 99, resetsAt: FIVE_HOUR_RESET },
      sevenDay: { utilization: 99, resetsAt: WEEKLY_RESET }
    })
    expect(applyClaudeAccountLimit(usage)).toEqual(usage)
  })

  test('a per-model window spent on its own that resets after the block keeps its own reset', () => {
    const later = '2026-09-15T00:00:00.000Z'
    const folded = applyClaudeAccountLimit(
      claude({ weeklyScoped: [{ modelName: 'Fable', utilization: 100, resetsAt: later }] })
    )
    expect(folded.weeklyScoped).toEqual([{ modelName: 'Fable', utilization: 100, resetsAt: later }])
  })

  test('a window the upstream did not report is not invented', () => {
    const folded = applyClaudeAccountLimit(claude({ fiveHour: null, weeklyScoped: [] }))
    expect(folded.fiveHour).toBeNull()
    expect(folded.weeklyScoped).toEqual([])
  })
})

describe('applyCodexAccountLimit', () => {
  const PRIMARY_RESET = '2026-09-11T05:00:00.000Z'
  const SECONDARY_RESET = '2026-09-14T00:00:00.000Z'

  const codex = (primaryPct: number, secondaryPct: number): CodexUsage => ({
    subAccountId: 'acct-codex',
    accountLabel: 'bob',
    planType: 'plus',
    primary: { usedPercent: primaryPct, resetAt: PRIMARY_RESET, windowSeconds: 18_000 },
    secondary: { usedPercent: secondaryPct, resetAt: SECONDARY_RESET, windowSeconds: 604_800 },
    capturedAt: '2026-09-11T00:00:00.000Z'
  })

  test('a spent secondary (7d) reads the primary (5h) as spent until the secondary resets', () => {
    expect(applyCodexAccountLimit(codex(12, 100)).primary).toEqual({
      usedPercent: 100,
      resetAt: SECONDARY_RESET,
      windowSeconds: 18_000
    })
  })

  test('a spent primary (5h) reads the secondary (7d) as spent until the primary resets', () => {
    expect(applyCodexAccountLimit(codex(100, 65)).secondary).toEqual({
      usedPercent: 100,
      resetAt: PRIMARY_RESET,
      windowSeconds: 604_800
    })
  })

  test('below the ceiling both windows are left alone', () => {
    const usage = codex(99, 99)
    expect(applyCodexAccountLimit(usage)).toEqual(usage)
  })
})

import { describe, expect, test } from 'bun:test'
import dayjs from '../../src/lib/dayjs'
import type { ClaudeUsage, CodexUsage } from '../../src/schemas/api/usage'
import { aggregatePaceHistory, claudeHistoryRows, codexHistoryRows } from '../../src/services/usage-history-service'

const NOW = Date.parse('2026-09-04T01:20:00Z')
const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const iso = (ms: number): string => dayjs(ms).toISOString()

const claude = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  subAccountId: 'a',
  accountLabel: 'a',
  fiveHour: { utilization: 60, resetsAt: iso(NOW + 2.5 * HOUR) },
  sevenDay: null,
  sevenDaySonnet: null,
  sevenDayOpus: null,
  weeklyScoped: [{ modelName: 'Fable', utilization: 30, resetsAt: iso(NOW + WEEK / 2) }],
  extraUsageEnabled: false,
  capturedAt: iso(NOW),
  ...over
})

const codex = (over: Partial<CodexUsage> = {}): CodexUsage => ({
  subAccountId: 'b',
  accountLabel: 'b',
  planType: 'prolite',
  primary: { usedPercent: 20, resetAt: iso(NOW + HOUR / 2), windowSeconds: 3600 },
  secondary: null,
  resetCredits: null,
  capturedAt: iso(NOW),
  ...over
})

describe('account pace history', () => {
  test('records Claude windows with their account, weight and observation-time projection', () => {
    const rows = claudeHistoryRows(claude(), { kind: 'claude', plan: 'claude_max', rateLimitTier: '20x' }, NOW)
    expect(rows.map((r) => [r.subAccountId, r.metric, r.planWeight, r.projectedPct])).toEqual([
      ['a', 'claude.five_hour', 20, 120],
      ['a', 'claude.seven_day_scoped.fable', 20, 60]
    ])
  })

  test('uses Codex-reported duration and does not infer missing duration', () => {
    const rows = codexHistoryRows(
      codex({ secondary: { usedPercent: 90, resetAt: iso(NOW + HOUR), windowSeconds: null } }),
      { kind: 'codex', plan: 'prolite', rateLimitTier: null },
      NOW
    )
    expect(rows.map((r) => [r.planWeight, r.projectedPct])).toEqual([
      [5, 40],
      [5, null]
    ])
  })

  test('records and exposes an early weekly Codex forecast instead of a chart gap', () => {
    const rows = codexHistoryRows(
      codex({ primary: { usedPercent: 90, resetAt: iso(NOW + 0.95 * WEEK), windowSeconds: 604_800 } }),
      { kind: 'codex', plan: 'pro', rateLimitTier: null },
      NOW
    )
    expect(rows[0].percent).toBe(90)
    expect(rows[0].projectedPct).toBeCloseTo(1800)
    expect(aggregatePaceHistory(rows)).toEqual([{ metric: 'codex.primary', t: iso(NOW), projectedPct: 1800 }])
  })

  test('records idle zero-use windows without a reset as zero, but keeps unknown nonzero pace null', () => {
    const rows = claudeHistoryRows(
      claude({ fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null } }),
      undefined,
      NOW
    )
    expect(rows[0].projectedPct).toBe(0)
    expect(rows[1].projectedPct).toBeNull()
    expect(claudeHistoryRows(claude({ fiveHour: null, weeklyScoped: [] }), undefined, NOW)).toEqual([])
    expect(
      claudeHistoryRows(
        claude({ fiveHour: { utilization: 0, resetsAt: null }, capturedAt: iso(NOW - 16 * 60_000) }),
        undefined,
        NOW
      )
    ).toEqual([])
  })

  test('uses capture time, not collection time, and rejects a stale cached read', () => {
    const fresh = claudeHistoryRows(claude({ capturedAt: iso(NOW - 2 * 60_000) }), undefined, NOW)
    expect(fresh[0].projectedPct).toBeGreaterThan(120)
    expect(claudeHistoryRows(claude({ capturedAt: iso(NOW - 16 * 60_000) }), undefined, NOW)).toEqual([])
  })

  test('unknown and old aggregate rows never masquerade as zero or distort weighted pace', () => {
    const capturedAt = dayjs(NOW).toDate()
    const base = { metric: 'claude.five_hour', capturedAt }
    const samples = aggregatePaceHistory([
      { ...base, subAccountId: 'pro', planWeight: 1, projectedPct: 200 },
      { ...base, subAccountId: 'max', planWeight: 20, projectedPct: 20 },
      { ...base, subAccountId: 'unknown', planWeight: 1, projectedPct: null },
      { ...base, subAccountId: null, planWeight: null, projectedPct: null },
      { ...base, metric: 'claude.seven_day', subAccountId: null, planWeight: null, projectedPct: null }
    ])
    expect(samples).toEqual([
      { metric: 'claude.five_hour', t: iso(NOW), projectedPct: 28.6 },
      { metric: 'claude.seven_day', t: iso(NOW), projectedPct: null }
    ])
  })
})

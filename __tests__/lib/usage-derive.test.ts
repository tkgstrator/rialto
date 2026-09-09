/**
 * Shaping behind Activity › Usage.
 *
 * Three claims worth pinning, because each fails silently on screen:
 * the per-model weekly windows survive the flattening (they are the whole
 * reason the panel exists — Overview drops them); the history downsample
 * keeps peaks rather than averaging them away; and the per-token share
 * column divides by the priced total, so it cannot report a share of
 * money that was never priced.
 */

import { describe, expect, test } from 'bun:test'
import {
  accountWindows,
  bucketSamples,
  chartCsvRows,
  metricLabel,
  seriesOf,
  tokenUsageRows,
  type UsageHistorySample,
  type UsageWire
} from '../../src/components/rialto/activity/usage-derive'
import type { AccessTokenWire } from '../../src/lib/api'

// The label lookup is i18n's job; the shaping is what these test. Echoing
// the key keeps assertions about structure readable.
const t = (key: string): string => key

const emptyUsage = (): UsageWire => ({ claude: [], codex: [] })

const claudeAccount = (over: Partial<UsageWire['claude'][number]> = {}): UsageWire['claude'][number] => ({
  subAccountId: 'sa1',
  accountLabel: 'Yuki',
  fiveHour: { utilization: 3, resetsAt: '2026-09-04T05:20:00Z' },
  sevenDay: { utilization: 41, resetsAt: '2026-09-05T15:00:00Z' },
  sevenDaySonnet: null,
  sevenDayOpus: null,
  weeklyScoped: [],
  extraUsageEnabled: false,
  capturedAt: '2026-09-04T01:20:00Z',
  ...over
})

describe('accountWindows', () => {
  test('keeps the per-model weekly windows Overview drops', () => {
    const usage: UsageWire = {
      claude: [
        claudeAccount({
          weeklyScoped: [{ modelName: 'Fable', utilization: 11, resetsAt: '2026-09-05T15:00:00Z' }]
        })
      ],
      codex: []
    }
    const [account] = accountWindows(usage, t)
    const scoped = account.windows.filter((w) => w.scope !== null)
    expect(scoped).toHaveLength(1)
    expect(scoped[0].scope).toBe('Fable')
    expect(scoped[0].pct).toBe(11)
  })

  test('account-wide windows come before the scoped ones', () => {
    // Scanning for "am I near the wall" reads the account-wide limit
    // first; a per-model row above it answers a narrower question.
    const usage: UsageWire = {
      claude: [claudeAccount({ weeklyScoped: [{ modelName: 'Fable', utilization: 11, resetsAt: null }] })],
      codex: []
    }
    const [account] = accountWindows(usage, t)
    expect(account.windows.map((w) => w.scope)).toEqual([null, null, 'Fable'])
  })

  test('an absent window is omitted rather than drawn as 0%', () => {
    // Null means the vendor did not report the window. A 0% meter would
    // claim the opposite — that it is reported and untouched.
    const usage: UsageWire = { claude: [claudeAccount({ fiveHour: null })], codex: [] }
    const [account] = accountWindows(usage, t)
    expect(account.windows).toHaveLength(1)
    expect(account.windows[0].label).toBe('activity.usage.windowSevenDay')
  })

  test('the legacy sonnet/opus fields render as scoped windows when present', () => {
    const usage: UsageWire = {
      claude: [claudeAccount({ sevenDayOpus: { utilization: 64, resetsAt: null } })],
      codex: []
    }
    const [account] = accountWindows(usage, t)
    expect(account.windows.map((w) => w.scope)).toEqual([null, null, 'Opus'])
  })

  test('codex accounts carry their plan and both windows', () => {
    const usage: UsageWire = {
      claude: [],
      codex: [
        {
          subAccountId: 'sa2',
          accountLabel: 'ops',
          planType: 'pro',
          primary: { usedPercent: 88, resetAt: null, windowSeconds: null },
          secondary: { usedPercent: 22, resetAt: null, windowSeconds: null },
          capturedAt: '2026-09-04T01:20:00Z'
        }
      ]
    }
    const [account] = accountWindows(usage, t)
    expect(account.plan).toBe('pro')
    expect(account.windows.map((w) => w.pct)).toEqual([88, 22])
  })

  test('no connected accounts is an empty list, not a throw', () => {
    expect(accountWindows(emptyUsage(), t)).toEqual([])
  })
})

describe('metricLabel', () => {
  test('names the flat collector metrics', () => {
    expect(metricLabel('claude.five_hour', t)).toBe('activity.usage.windowFiveHour')
    expect(metricLabel('codex.primary', t)).toBe('activity.usage.windowPrimary')
  })

  test('title-cases the scoped slug rather than looking it up in a table', () => {
    // A table would need extending for every model Anthropic adds, and a
    // stale table renders a blank legend entry.
    expect(metricLabel('claude.seven_day_scoped.fable', t)).toBe('activity.usage.windowSevenDay · Fable')
  })

  test('an unrecognised metric falls back to its own key', () => {
    expect(metricLabel('vendor.something_new', t)).toBe('vendor.something_new')
  })
})

describe('bucketSamples', () => {
  const at = (minutes: number): string => new Date(Date.UTC(2026, 8, 1, 0, minutes)).toISOString()
  const sample = (minutes: number, percent: number, metric = 'claude.five_hour'): UsageHistorySample => ({
    metric,
    percent,
    t: at(minutes),
    resetAt: null
  })

  test('keeps the peak in a bucket, not the average', () => {
    // The question is "how close to the wall did this get". A window that
    // touched 95% and fell back is the event worth seeing; a mean erases it.
    const points = bucketSamples([sample(0, 10), sample(1, 95), sample(2, 12)], 1)
    expect(points).toHaveLength(1)
    expect(points[0]['claude.five_hour']).toBe(95)
  })

  test('collapses ~2000 samples to the requested bucket count', () => {
    const samples = Array.from({ length: 2016 }, (_, i) => sample(i * 5, i % 100))
    expect(bucketSamples(samples, 120).length).toBeLessThanOrEqual(120)
  })

  test('a bucket with no sample for a metric emits null, so the line breaks', () => {
    // Joining across a collector outage would draw a straight line through
    // hours nobody measured.
    const points = bucketSamples([sample(0, 10, 'a'), sample(600, 20, 'b')], 2)
    expect(points[0].b).toBeNull()
    expect(points[points.length - 1].a).toBeNull()
  })

  test('every metric is present on every point, so the chart keys are stable', () => {
    const points = bucketSamples([sample(0, 10, 'a'), sample(60, 20, 'b')], 4)
    for (const point of points) {
      expect(Object.hasOwn(point, 'a')).toBe(true)
      expect(Object.hasOwn(point, 'b')).toBe(true)
    }
  })

  test('a single instant collapses to one point instead of dividing by zero', () => {
    const points = bucketSamples([sample(0, 10), sample(0, 40)], 12)
    expect(points).toHaveLength(1)
    expect(points[0]['claude.five_hour']).toBe(40)
  })

  test('no samples is an empty chart, not a crash', () => {
    expect(bucketSamples([], 12)).toEqual([])
  })
})

describe('seriesOf', () => {
  test('deduplicates and orders so the legend does not reshuffle between polls', () => {
    const samples: UsageHistorySample[] = [
      { metric: 'claude.seven_day', percent: 1, t: '2026-09-01T00:00:00Z', resetAt: null },
      { metric: 'claude.five_hour', percent: 1, t: '2026-09-01T00:00:00Z', resetAt: null },
      { metric: 'claude.seven_day', percent: 2, t: '2026-09-01T00:05:00Z', resetAt: null }
    ]
    expect(seriesOf(samples, t).map((s) => s.metric)).toEqual(['claude.five_hour', 'claude.seven_day'])
  })
})

describe('chartCsvRows', () => {
  const series = [
    { metric: 'a', label: '5-hour' },
    { metric: 'b', label: '7-day' }
  ]

  test('exports the plotted buckets, headed by the legend labels', () => {
    const rows = chartCsvRows([{ t: Date.UTC(2026, 8, 1), a: 10, b: 20 }], series)
    expect(rows[0]).toEqual(['time', '5-hour', '7-day'])
    expect(rows[1]).toEqual(['2026-09-01T00:00:00.000Z', '10', '20'])
  })

  test('an unmeasured bucket exports empty, not zero', () => {
    // Same reason the line breaks there: nobody measured it, and a 0
    // in a spreadsheet is a measurement.
    const rows = chartCsvRows([{ t: Date.UTC(2026, 8, 1), a: null, b: 20 }], series)
    expect(rows[1]).toEqual(['2026-09-01T00:00:00.000Z', '', '20'])
  })

  test('a header-only export is what an empty chart produces', () => {
    expect(chartCsvRows([], series)).toEqual([['time', '5-hour', '7-day']])
  })
})

describe('tokenUsageRows', () => {
  const token = (over: Partial<AccessTokenWire>): AccessTokenWire => ({
    id: 'tok',
    name: 'CI',
    prefix: 'rialto_0d18',
    surfaces: [],
    profileKey: null,
    lastUsedAt: null,
    requestCount: 0,
    costUsd: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over
  })

  test('shares are of the priced total and add up to 100', () => {
    const rows = tokenUsageRows([token({ id: 'a', costUsd: 75 }), token({ id: 'b', costUsd: 25 })])
    expect(rows.map((r) => r.sharePct)).toEqual([75, 25])
  })

  test('unpriced traffic is excluded from the denominator, not counted as zero', () => {
    // Subscription traffic prices to null. Folding it in as $0 would
    // report a share of a total that does not exist.
    const rows = tokenUsageRows([
      token({ id: 'a', costUsd: 40 }),
      token({ id: 'b', costUsd: null, requestCount: 9_000 })
    ])
    const priced = rows.find((r) => r.id === 'a')
    const unpriced = rows.find((r) => r.id === 'b')
    expect(priced?.sharePct).toBe(100)
    expect(unpriced?.sharePct).toBeNull()
  })

  test('unpriced tokens sort last — unknown is not cheap', () => {
    const rows = tokenUsageRows([
      token({ id: 'unpriced', costUsd: null, requestCount: 9_000 }),
      token({ id: 'cheap', costUsd: 0.5 })
    ])
    expect(rows.map((r) => r.id)).toEqual(['cheap', 'unpriced'])
  })

  test('revoked tokens stay in the table', () => {
    // Their traffic is part of what the window cost. Dropping them makes
    // the surviving shares add up to more than the money actually spent.
    const rows = tokenUsageRows([
      token({ id: 'live', costUsd: 50 }),
      token({ id: 'dead', costUsd: 50, revokedAt: '2026-09-02T00:00:00Z' })
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.sharePct)).toEqual([50, 50])
  })

  test('no priced traffic at all leaves every share null rather than NaN', () => {
    const rows = tokenUsageRows([token({ id: 'a' }), token({ id: 'b' })])
    expect(rows.every((r) => r.sharePct === null)).toBe(true)
  })
})

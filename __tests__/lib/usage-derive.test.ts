/**
 * Shaping behind Activity › Usage.
 *
 * The claims worth pinning, because each fails silently on screen:
 * accounts land under the provider that owns them, named by a plan that
 * says which of a vendor's two top plans the seat is on; the per-model
 * weekly windows survive the flattening (they are the whole reason the
 * panel exists — Overview drops them); the history downsample keeps peaks
 * rather than averaging them away; and the per-token share column divides
 * by the priced total, so it cannot report a share of money that was
 * never priced.
 */

import { describe, expect, test } from 'bun:test'
import {
  bucketSamples,
  metricLabel,
  providerWindows,
  seriesOf,
  tokenUsageRows,
  type UsageHistorySample,
  type UsageWire
} from '../../src/components/rialto/activity/usage-derive'
import type { SubAccountWire, SubscriptionWire } from '../../src/components/rialto/providers/types'
import type { AccessTokenWire } from '../../src/lib/api'

// The label lookup is i18n's job; the shaping is what these test. Echoing
// the key keeps assertions about structure readable.
const t = (key: string): string => key

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

const codexAccount = (over: Partial<UsageWire['codex'][number]> = {}): UsageWire['codex'][number] => ({
  subAccountId: 'sa2',
  accountLabel: 'ops',
  planType: 'pro',
  primary: { usedPercent: 88, resetAt: null, windowSeconds: 18_000 },
  secondary: { usedPercent: 22, resetAt: null, windowSeconds: 604_800 },
  capturedAt: '2026-09-04T01:20:00Z',
  ...over
})

const seat = (id: string, over: Partial<SubAccountWire> = {}): SubAccountWire => ({
  id,
  label: id,
  sourcePath: `oauth:${id}`,
  enabled: true,
  userName: null,
  userEmail: null,
  userId: null,
  plan: null,
  rateLimitTier: null,
  monthlyPriceUsd: null,
  expiresAt: null,
  subscriptionEndsAt: null,
  authStatus: 'live',
  authCheckedAt: null,
  authError: null,
  scopes: [],
  ...over
})

const provider = (
  providerName: string,
  kind: SubscriptionWire['kind'],
  accounts: SubAccountWire[]
): SubscriptionWire => ({ providerName, kind, enabled: true, accounts })

// The window shaping does not depend on grouping, so these read the one
// account an unlisted usage response produces.
const windowsOf = (usage: UsageWire) => providerWindows(usage, [], t)[0].accounts[0].windows

describe('providerWindows — grouping', () => {
  test('accounts land under the provider that owns them, never interleaved', () => {
    // The regression: Claude's accounts then Codex's flowed through one
    // grid, so a row could hold one of each with nothing saying which.
    const usage: UsageWire = {
      claude: [claudeAccount({ subAccountId: 'c1' }), claudeAccount({ subAccountId: 'c2' })],
      codex: [codexAccount({ subAccountId: 'x1' })]
    }
    const groups = providerWindows(
      usage,
      [provider('claude-code', 'claude', [seat('c1'), seat('c2')]), provider('codex', 'codex', [seat('x1')])],
      t
    )
    expect(groups.map((g) => [g.key, g.accounts.map((a) => a.subAccountId)])).toEqual([
      ['claude-code', ['c1', 'c2']],
      ['codex', ['x1']]
    ])
  })

  test('two providers on one vendor stay apart, and the row name is what tells them apart', () => {
    const usage: UsageWire = {
      claude: [claudeAccount({ subAccountId: 'a' }), claudeAccount({ subAccountId: 'b' })],
      codex: []
    }
    const groups = providerWindows(
      usage,
      [provider('claude-code', 'claude', [seat('a')]), provider('claude-work', 'claude', [seat('b')])],
      t
    )
    // A hand-added provider's label is its row name, so it is not repeated.
    expect(groups.map((g) => [g.label, g.name])).toEqual([
      ['Claude Code', 'claude-code'],
      ['claude-work', null]
    ])
  })

  test('a provider with nothing in the usage response is left out', () => {
    const groups = providerWindows(
      { claude: [], codex: [codexAccount({ subAccountId: 'x1' })] },
      [provider('claude-code', 'claude', [seat('c1')]), provider('codex', 'codex', [seat('x1')])],
      t
    )
    expect(groups.map((g) => g.key)).toEqual(['codex'])
  })

  test('an account no provider lists is still shown, under its vendor', () => {
    // The subscriptions read failed, or the account went between the two
    // reads. Dropping it would hide a window that is really being spent.
    const groups = providerWindows({ claude: [claudeAccount({ subAccountId: 'lost' })], codex: [] }, [], t)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Claude')
    expect(groups[0].accounts.map((a) => a.subAccountId)).toEqual(['lost'])
  })

  test('no connected accounts is an empty list, not a throw', () => {
    expect(providerWindows({ claude: [], codex: [] }, [], t)).toEqual([])
  })
})

describe('providerWindows — plan names', () => {
  test('Claude Max takes its multiplier from the rate limit tier', () => {
    const usage: UsageWire = { claude: [claudeAccount({ subAccountId: 'c1' })], codex: [] }
    const [group] = providerWindows(
      usage,
      [
        provider('claude-code', 'claude', [seat('c1', { plan: 'claude_max', rateLimitTier: 'default_claude_max_20x' })])
      ],
      t
    )
    expect(group.accounts[0].plan).toBe('Max 20x')
  })

  test('Codex reads the live plan_type over the stored plan', () => {
    // The stored plan dates from the last sign-in; a seat moved to Pro 5x
    // since then shows the answer the vendor gives now.
    const usage: UsageWire = { claude: [], codex: [codexAccount({ subAccountId: 'x1', planType: 'prolite' })] }
    const [group] = providerWindows(usage, [provider('codex', 'codex', [seat('x1', { plan: 'pro' })])], t)
    expect(group.accounts[0].plan).toBe('Pro 5x')
  })

  test('Codex falls back to the stored plan when the usage response carries none', () => {
    const usage: UsageWire = { claude: [], codex: [codexAccount({ subAccountId: 'x1', planType: null })] }
    const [group] = providerWindows(usage, [provider('codex', 'codex', [seat('x1', { plan: 'pro' })])], t)
    expect(group.accounts[0].plan).toBe('Pro 20x')
  })

  test('an account that reports no plan gets no pill rather than an empty one', () => {
    const usage: UsageWire = { claude: [claudeAccount({ subAccountId: 'c1' })], codex: [] }
    const [group] = providerWindows(usage, [provider('claude-code', 'claude', [seat('c1')])], t)
    expect(group.accounts[0].plan).toBeNull()
  })
})

describe('providerWindows — windows', () => {
  test('keeps the per-model weekly windows Overview drops', () => {
    const windows = windowsOf({
      claude: [
        claudeAccount({ weeklyScoped: [{ modelName: 'Fable', utilization: 11, resetsAt: '2026-09-05T15:00:00Z' }] })
      ],
      codex: []
    })
    const scoped = windows.filter((w) => w.scope !== null)
    expect(scoped).toHaveLength(1)
    expect(scoped[0].scope).toBe('Fable')
    expect(scoped[0].pct).toBe(11)
  })

  test('account-wide windows come before the scoped ones', () => {
    // Scanning for "am I near the wall" reads the account-wide limit
    // first; a per-model row above it answers a narrower question.
    const windows = windowsOf({
      claude: [claudeAccount({ weeklyScoped: [{ modelName: 'Fable', utilization: 11, resetsAt: null }] })],
      codex: []
    })
    expect(windows.map((w) => w.scope)).toEqual([null, null, 'Fable'])
  })

  test('an absent window is omitted rather than drawn as 0%', () => {
    // Null means the vendor did not report the window. A 0% meter would
    // claim the opposite — that it is reported and untouched.
    const windows = windowsOf({ claude: [claudeAccount({ fiveHour: null })], codex: [] })
    expect(windows).toHaveLength(1)
    expect(windows[0].label).toBe('activity.usage.windowSevenDay')
  })

  test('the legacy sonnet/opus fields render as scoped windows when present', () => {
    const windows = windowsOf({
      claude: [claudeAccount({ sevenDayOpus: { utilization: 64, resetsAt: null } })],
      codex: []
    })
    expect(windows.map((w) => w.scope)).toEqual([null, null, 'Opus'])
  })

  test("Codex windows are named by their length, the way Claude's are", () => {
    // Codex calls them primary and secondary. Beside Claude's 5-hour and
    // 7-day rows, that made the same two limits look like different ones.
    const windows = windowsOf({ claude: [], codex: [codexAccount()] })
    expect(windows.map((w) => w.label)).toEqual(['activity.usage.windowFiveHour', 'activity.usage.windowSevenDay'])
    expect(windows.map((w) => w.pct)).toEqual([88, 22])
  })

  test('a Codex window of any other length keeps its rank', () => {
    const windows = windowsOf({
      claude: [],
      codex: [codexAccount({ primary: { usedPercent: 5, resetAt: null, windowSeconds: 3_600 }, secondary: null })]
    })
    expect(windows.map((w) => w.label)).toEqual(['activity.usage.windowPrimary'])
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

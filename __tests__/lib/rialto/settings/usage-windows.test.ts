import { describe, expect, test } from 'bun:test'
import type { UsageWindowWire } from '../../../../src/lib/api-types'
import {
  fmtResetAt,
  fmtUsd,
  usageBlocked,
  usageWindowsView,
  windowView,
  zoneName,
  zoneOffset
} from '../../../../src/lib/rialto/settings/usage-windows'

// The mock's snapshot: Sep 29, 2026 15:19 JST. The 5-hour window resets
// at 18:00 JST, the 7-day one on Oct 3 at 09:00 JST.
const FIVE_RESET = '2026-09-29T09:00:00.000Z'
const WEEK_RESET = '2026-10-03T00:00:00.000Z'

const row = (over: Partial<UsageWindowWire> & Pick<UsageWindowWire, 'window'>): UsageWindowWire => ({
  startedAt: null,
  resetsAt: null,
  requests: 0,
  requestLimit: null,
  costUsd: 0,
  spendLimitUsd: null,
  ...over
})

// Free: 100 requests / $2 per 5 hours, 500 requests / $10 per 7 days.
const free = (five: Partial<UsageWindowWire>, week: Partial<UsageWindowWire>) => ({
  limited: true,
  windows: [
    row({ window: '5h', requestLimit: 100, spendLimitUsd: 2, ...five }),
    row({ window: '7d', requestLimit: 500, spendLimitUsd: 10, ...week })
  ]
})

const open5 = { startedAt: '2026-09-29T04:00:00.000Z', resetsAt: FIVE_RESET }
const open7 = { startedAt: '2026-09-26T00:00:00.000Z', resetsAt: WEEK_RESET }

describe('window state', () => {
  test('open and under its limits: meters, no block', () => {
    const view = usageWindowsView(
      'Free',
      free({ ...open5, requests: 42, costUsd: 0.84 }, { ...open7, requests: 286, costUsd: 5.72 })
    )
    expect(view.kind).toBe('limited')
    if (view.kind !== 'limited') return
    expect(view.block).toBeNull()
    expect(view.resettable).toBe(true)
    expect(view.windows[0].requests).toEqual({ used: 42, limit: 100, pct: 42 })
    expect(view.windows[0].spend.pct).toBeCloseTo(42)
    expect(view.windows.map((w) => w.spentBy)).toEqual([[], []])
    expect(usageBlocked(view)).toBe(false)
  })

  test('5-hour requests spent: blocked until the 5-hour reset (?spent)', () => {
    const view = usageWindowsView(
      'Free',
      free({ ...open5, requests: 100, costUsd: 1.84 }, { ...open7, requests: 286, costUsd: 5.72 })
    )
    if (view.kind !== 'limited') throw new Error(view.kind)
    expect(view.windows[0].spentBy).toEqual(['requests'])
    expect(view.windows[0].requests.pct).toBe(100)
    expect(view.block).toEqual({ until: FIVE_RESET, reasons: [{ window: '5h', measure: 'requests' }] })
    expect(usageBlocked(view)).toBe(true)
  })

  test('7-day spend spent: blocked until the 7-day reset though 5 hours is free (?week-spent)', () => {
    const view = usageWindowsView(
      'Free',
      free({ ...open5, requests: 42, costUsd: 0.84 }, { ...open7, requests: 286, costUsd: 10 })
    )
    if (view.kind !== 'limited') throw new Error(view.kind)
    expect(view.block).toEqual({ until: WEEK_RESET, reasons: [{ window: '7d', measure: 'spend' }] })
  })

  test('both spent: the block lasts until the later reset, and names both', () => {
    const view = usageWindowsView('Free', free({ ...open5, requests: 100 }, { ...open7, costUsd: 12 }))
    if (view.kind !== 'limited') throw new Error(view.kind)
    expect(view.block?.until).toBe(WEEK_RESET)
    expect(view.block?.reasons).toHaveLength(2)
  })

  test('not started: zero, nothing to reset, never spent (?not-started)', () => {
    const view = usageWindowsView('Free', free({}, {}))
    if (view.kind !== 'limited') throw new Error(view.kind)
    expect(view.windows.every((w) => !w.started)).toBe(true)
    expect(view.resettable).toBe(false)
    expect(view.block).toBeNull()
  })

  test('a measure with no limit has no bar and is never spent (?partial)', () => {
    const view = windowView(row({ window: '7d', ...open7, requests: 5000, costUsd: 3, spendLimitUsd: 50 }))
    expect(view.requests).toEqual({ used: 5000, limit: null, pct: null })
    expect(view.spend.pct).toBeCloseTo(6)
    expect(view.spentBy).toEqual([])
  })

  test('no plan and a plan without limits are told apart (?no-plan, ?unlimited)', () => {
    expect(usageWindowsView(null, null)).toEqual({ kind: 'no-plan' })
    expect(usageWindowsView('Max', { limited: false, windows: [] })).toEqual({ kind: 'unlimited', planName: 'Max' })
    expect(usageWindowsView('Free', null)).toEqual({ kind: 'loading' })
  })
})

describe('reset times', () => {
  test('in the viewer zone, with its short name', () => {
    expect(fmtResetAt(FIVE_RESET, 'en', 'Asia/Tokyo')).toBe('Sep 29, 18:00 JST')
    expect(fmtResetAt(WEEK_RESET, 'en', 'Asia/Tokyo')).toBe('Oct 3, 09:00 JST')
    expect(zoneName(FIVE_RESET, 'en', 'America/Los_Angeles')).toBe('PDT')
    expect(zoneName(FIVE_RESET, 'en', 'UTC')).toBe('UTC')
  })

  test('the offset for the hint', () => {
    expect(zoneOffset(FIVE_RESET, 'Asia/Tokyo')).toBe('+09:00')
    expect(zoneOffset(FIVE_RESET, 'UTC')).toBe('+00:00')
  })

  test('spend always to the cent', () => {
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(10)).toBe('$10.00')
  })
})

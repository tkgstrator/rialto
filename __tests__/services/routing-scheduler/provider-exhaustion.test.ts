import { describe, expect, test } from 'bun:test'
import { providerExhaustionOf } from '../../../src/services/routing-scheduler/provider-exhaustion'
import type { AccountQuotaView, QuotaWindowState, RoutingSnapshot } from '../../../src/services/routing-scheduler/types'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const spent = (resetAt: number | null): QuotaWindowState => ({
  used: 100,
  limit: 100,
  resetAt,
  windowLengthMs: 7 * 24 * HOUR
})
const account = (over: Partial<AccountQuotaView> = {}): AccountQuotaView => ({
  subAccountId: 'a',
  providerName: 'claude-code',
  kind: 'claude',
  fiveHour: null,
  weekly: spent(NOW + 7 * HOUR),
  refreshedAt: NOW,
  stale: false,
  ...over
})
const snapshot = (accounts: AccountQuotaView[]): RoutingSnapshot => ({
  tickAt: NOW,
  tickCount: 1,
  consecutiveFailures: 0,
  degraded: false,
  targets: new Map(),
  accounts,
  soonestResetAt: null
})

describe('providerExhaustionOf', () => {
  test('all fresh accounts spent: earliest account release, after both spent windows roll', () => {
    const snap = snapshot([
      account({ fiveHour: spent(NOW + HOUR), weekly: spent(NOW + 7 * HOUR) }),
      account({ subAccountId: 'b', fiveHour: spent(NOW + 2 * HOUR), weekly: null })
    ])
    expect(providerExhaustionOf(snap, 'claude-code', NOW)).toEqual({ resetAt: NOW + 2 * HOUR })
  })

  test('missing provider, unknown, stale, and a peer with headroom do not close a provider', () => {
    expect(providerExhaustionOf(null, 'claude-code', NOW)).toBeNull()
    expect(providerExhaustionOf(snapshot([]), 'claude-code', NOW)).toBeNull()
    expect(providerExhaustionOf(snapshot([account()]), 'codex', NOW)).toBeNull()
    expect(
      providerExhaustionOf(snapshot([account(), account({ subAccountId: 'b', weekly: null })]), 'claude-code', NOW)
    ).toBeNull()
    expect(
      providerExhaustionOf(
        snapshot([account(), account({ subAccountId: 'b', weekly: { ...spent(NOW + HOUR), used: 99 } })]),
        'claude-code',
        NOW
      )
    ).toBeNull()
    expect(
      providerExhaustionOf(snapshot([account({ refreshedAt: NOW - 15 * 60_000 - 1 })]), 'claude-code', NOW)
    ).toBeNull()
    expect(providerExhaustionOf(snapshot([account({ refreshedAt: null })]), 'claude-code', NOW)).toBeNull()
  })

  test('an elapsed reset no longer confirms exhaustion even before a new tick', () => {
    expect(providerExhaustionOf(snapshot([account({ weekly: spent(NOW - 1) })]), 'claude-code', NOW)).toBeNull()
  })

  test('missing reset still confirms spent, but supplies no precise retry time', () => {
    expect(providerExhaustionOf(snapshot([account({ weekly: spent(null) })]), 'claude-code', NOW)).toEqual({
      resetAt: null
    })
    expect(
      providerExhaustionOf(
        snapshot([account(), account({ subAccountId: 'b', weekly: spent(null) })]),
        'claude-code',
        NOW
      )
    ).toEqual({ resetAt: null })
  })
})

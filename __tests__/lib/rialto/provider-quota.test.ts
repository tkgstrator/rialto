/**
 * The Quota column on Providers → Subscriptions.
 *
 * A provider with several accounts fails over between them, so its
 * headroom is what they hold together. Reading the worst account instead
 * called a provider exhausted while a second, untouched account sat
 * behind it — and with one account exhausted and one fresh, the number
 * shown was always the exhausted one's.
 *
 * Seats are not interchangeable either: the percentages are ratios over
 * different denominators, so they are folded by plan capacity, the same
 * 1 / 5 / 20 the routing scheduler weights its own pool budget by.
 */
import { describe, expect, test } from 'bun:test'
import {
  type AccountQuota,
  indexQuota,
  providerQuotaPct,
  type QuotaAccount,
  quotaForAccount
} from '../../../src/components/rialto/providers/derive'

const w = (window: string, pct: number, scope: string | null = null): AccountQuota => ({
  window,
  scope,
  pct,
  resetAt: null
})

const index = (rows: Array<[string, AccountQuota[]]>) =>
  indexQuota(rows.map(([subAccountId, windows]) => ({ subAccountId, windows })))

const pro = (id: string): QuotaAccount => ({ id, plan: 'claude_pro', rateLimitTier: 'default_claude_pro' })
const max5 = (id: string): QuotaAccount => ({ id, plan: 'claude_max', rateLimitTier: 'default_claude_max_5x' })
const max20 = (id: string): QuotaAccount => ({ id, plan: 'claude_max', rateLimitTier: 'default_claude_max_20x' })

describe('providerQuotaPct', () => {
  test('combines the same window across accounts instead of taking the worst', () => {
    const idx = index([
      ['a', [w('7d', 100)]],
      ['b', [w('7d', 0)]]
    ])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max5('b')])).toBe(50)
  })

  test('weights each seat by its plan — a spent 5x beside a fresh 20x is not half', () => {
    // 5 seats of 100% over 25 seats total. Averaging the two percentages
    // flat would report 50% and hide four fifths of the pool.
    const idx = index([
      ['a', [w('7d', 100)]],
      ['b', [w('7d', 0)]]
    ])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max20('b')])).toBe(20)
  })

  test('and the other way round — a spent 20x beside a fresh 5x', () => {
    const idx = index([
      ['a', [w('7d', 0)]],
      ['b', [w('7d', 100)]]
    ])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max20('b')])).toBe(80)
  })

  test('a Pro seat is a fifth of a Max', () => {
    const idx = index([
      ['a', [w('7d', 100)]],
      ['b', [w('7d', 0)]]
    ])
    expect(providerQuotaPct(idx, 'claude', [pro('a'), max5('b')])).toBe(17)
  })

  test('weighs a Codex pool by its own plan names', () => {
    // Plus is the unit and Pro a Max-class seat, so the spent Plus is a
    // sixth of this pool — not half of it.
    const idx = index([
      ['a', [w('7d', 60)]],
      ['b', [w('7d', 0)]]
    ])
    const codexPool: QuotaAccount[] = [
      { id: 'a', plan: 'codex_plus', rateLimitTier: 'default' },
      { id: 'b', plan: 'codex_pro', rateLimitTier: 'default' }
    ]
    expect(providerQuotaPct(idx, 'codex', codexPool)).toBe(10)
  })

  test('leaves a single account exactly as it reads, whatever its plan', () => {
    expect(providerQuotaPct(index([['a', [w('7d', 62)]]]), 'claude', [max20('a')])).toBe(62)
  })

  test('keeps windows apart, then reports the fullest of them', () => {
    // 5h averages to 80 and 7d to 20: the burst window is what binds, and
    // folding the two together would have hidden it at 50.
    const idx = index([
      ['a', [w('5h', 90), w('7d', 30)]],
      ['b', [w('5h', 70), w('7d', 10)]]
    ])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max5('b')])).toBe(80)
  })

  test('pairs a per-model weekly row with the same model on the other account', () => {
    // Both accounts are quiet overall, but both have spent their Fable
    // share — the scoped rows must meet each other, not the account-wide
    // 7d row they arrive alongside.
    const idx = index([
      ['a', [w('7d', 10), w('7d', 90, 'Fable')]],
      ['b', [w('7d', 10), w('7d', 70, 'Fable')]]
    ])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max5('b')])).toBe(80)
  })

  test('folds only the accounts that reported — an unread one is unknown, not zero', () => {
    const idx = index([['a', [w('7d', 80)]]])
    expect(providerQuotaPct(idx, 'claude', [max5('a'), max20('b')])).toBe(80)
  })

  test('is null when no account has been read at all', () => {
    expect(providerQuotaPct(index([]), 'claude', [max5('a')])).toBeNull()
  })
})

describe('quotaForAccount', () => {
  test('prefers the account-wide weekly over a per-model row of the same window', () => {
    const idx = index([['a', [w('5h', 5), w('7d', 40), w('7d', 95, 'Fable')]]])
    expect(quotaForAccount(idx, 'a')).toEqual(w('7d', 40))
  })

  test('falls back to the first window when the collector has no weekly', () => {
    const idx = index([['a', [w('5h', 5)]]])
    expect(quotaForAccount(idx, 'a')).toEqual(w('5h', 5))
  })
})

/**
 * How a chain row reports a target the scheduler could not measure.
 *
 * An api_key provider has no quota window, so the scheduler has no
 * budget to read and falls back to its "unknown budget → treat as
 * usable" policy, publishing a factor of 1.0. Rendered naively that
 * became a green-adjacent `100%` sitting next to a measured `73%`, as if
 * the two were the same kind of number, and a permanent `throttled` pill
 * on a provider nothing was throttling.
 */

import { describe, expect, test } from 'bun:test'
import { chainShares, hasBudgetReading, targetLabels, targetState } from '../../src/components/rialto/routing/derive'
import type { RoutingSchedulerWeightEntry } from '../../src/lib/api-types'

const entry = (over: Partial<RoutingSchedulerWeightEntry>): RoutingSchedulerWeightEntry => ({
  target: 'p,m',
  weight: 1,
  healthiness: 1,
  remainingBudgetPct: 50,
  earliestResetAt: null,
  reasons: ['ok'],
  ...over
})

describe('targetState', () => {
  test('a measured, healthy target is ready', () => {
    expect(targetState(entry({}))).toBe('ready')
    expect(hasBudgetReading(entry({}))).toBe(true)
  })

  test('a measured target the scheduler annotated is throttled', () => {
    expect(targetState(entry({ reasons: ['reset_soon'] }))).toBe('throttled')
  })

  test('zero weight is exhausted whatever else is true', () => {
    expect(targetState(entry({ weight: 0, remainingBudgetPct: null }))).toBe('exhausted')
  })

  test('no budget reading is unknown, not throttled', () => {
    const unmeasured = entry({ remainingBudgetPct: null, reasons: ['unknown_budget'] })
    expect(targetState(unmeasured)).toBe('unknown')
    expect(hasBudgetReading(unmeasured)).toBe(false)
  })

  test('a stale poll is unknown too — the number it would show is a policy default', () => {
    expect(targetState(entry({ remainingBudgetPct: null, reasons: ['stale_quota'], weight: 0.25 }))).toBe('unknown')
  })

  test('a target with no snapshot at all stays unknown', () => {
    expect(targetState(undefined)).toBe('unknown')
    expect(hasBudgetReading(undefined)).toBe(false)
  })
})

/**
 * The Share column has one job the eye checks instantly: it adds up.
 * Rounding each row independently does not — three equal targets give
 * 33/33/33 — so the apportionment is largest-remainder.
 */
describe('chainShares', () => {
  const row = (target: string, weight: number | undefined, enabled = true) => ({ target, enabled, weight })
  const total = (shares: Map<string, number | null>) =>
    [...shares.values()].reduce((sum: number, v) => sum + (v === null ? 0 : v), 0)

  test('three equal targets still add to 100', () => {
    const shares = chainShares([row('a,1', 1), row('b,1', 1), row('c,1', 1)])
    expect(total(shares)).toBe(100)
    // 34/33/33: the extra point goes to the first row of the tie, which
    // is the operator's own priority order.
    expect(shares.get('a,1')).toBe(34)
    expect(shares.get('b,1')).toBe(33)
    expect(shares.get('c,1')).toBe(33)
  })

  test('shares are proportional to the published weight', () => {
    const shares = chainShares([row('a,1', 0.6), row('b,1', 1), row('c,1', 1)])
    expect(total(shares)).toBe(100)
    expect(shares.get('a,1')).toBe(23)
  })

  test('a disabled row takes no share and reads as a dash', () => {
    const shares = chainShares([row('a,1', 1), row('b,1', 1, false)])
    expect(shares.get('a,1')).toBe(100)
    expect(shares.get('b,1')).toBeNull()
  })

  test('a row the scheduler has not scored reads as a dash', () => {
    const shares = chainShares([row('a,1', 1), row('b,1', undefined)])
    expect(shares.get('b,1')).toBeNull()
    expect(total(shares)).toBe(100)
  })

  test('an exhausted row keeps its place at 0%', () => {
    const shares = chainShares([row('a,1', 1), row('b,1', 0)])
    expect(shares.get('b,1')).toBe(0)
    expect(total(shares)).toBe(100)
  })

  test('a lane with nothing to apportion shows no percentages', () => {
    const shares = chainShares([row('a,1', 0), row('b,1', 0)])
    expect(total(shares)).toBe(0)
  })

  test('a single enabled target holds the whole lane', () => {
    expect(chainShares([row('a,1', 0.42)]).get('a,1')).toBe(100)
  })
})

/**
 * The Target column shows the model, because the provider half repeats
 * down the column. The exception is the case where dropping it would
 * make two rows of one lane read identically — the same model reached
 * through a subscription and through an api_key account, which is an
 * ordinary failover chain rather than an edge case.
 */
describe('targetLabels', () => {
  test('a lane of distinct models shows model names', () => {
    const labels = targetLabels(['claude-code,claude-sonnet-5', 'openai,gpt-5.6-terra'])
    expect(labels.get('claude-code,claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(labels.get('openai,gpt-5.6-terra')).toBe('gpt-5.6-terra')
  })

  test('a model served by two providers keeps the provider on BOTH rows', () => {
    const labels = targetLabels(['claude-code,claude-sonnet-5', 'anthropic,claude-sonnet-5', 'openai,gpt-5.6-terra'])
    expect(labels.get('claude-code,claude-sonnet-5')).toBe('claude-code,claude-sonnet-5')
    expect(labels.get('anthropic,claude-sonnet-5')).toBe('anthropic,claude-sonnet-5')
    // The unambiguous row in the same lane still shortens.
    expect(labels.get('openai,gpt-5.6-terra')).toBe('gpt-5.6-terra')
  })

  test('a model name containing a comma keeps everything after the first one', () => {
    expect(targetLabels(['p,weird,name']).get('p,weird,name')).toBe('weird,name')
  })
})

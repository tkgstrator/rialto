/**
 * How a chain row reports a target the scheduler could not measure.
 *
 * An api_key provider has no quota window, so the scheduler has no
 * budget to read and falls back to its "unknown budget → treat as
 * usable" policy, publishing a factor of 1.0. Rendered naively that
 * became a green-adjacent `100%` sitting next to a measured `73%`, as if
 * the two were the same kind of number.
 *
 * The `targetState` cases that used to open this file went with the
 * State column: with no pill to classify a target for, the classifier
 * had no production reader left. What survives is the apportionment,
 * which is the thing the column that replaced it actually shows.
 */

import { describe, expect, test } from 'bun:test'
import { chainShares, targetLabels } from '../../src/components/rialto/routing/derive'

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

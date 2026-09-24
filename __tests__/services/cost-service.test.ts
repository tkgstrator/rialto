/**
 * computeCosts prices a cache write by its TTL.
 *
 * Anthropic bills a 5-minute cache write at 1.25x the input price and a
 * 1-hour write at 2x. RequestLog keeps the 1-hour share beside the total
 * (`cacheWrite1hTokens` is included in `cacheWriteTokens`, not added to
 * it), so the price has to split the total rather than add the two.
 */

import { expect, test } from 'bun:test'
import { computeCosts, type PriceEntry } from '../../src/services/cost-service'

// $10 per million input tokens makes the arithmetic readable: one
// million 5m writes cost $12.50, one million 1h writes $20.
const PRICES = new Map<string, PriceEntry>([
  ['anthropic||claude-sonnet-5', { inputPer1M: 10, outputPer1M: 50, cachedInputPer1M: 1 }]
])

const row = (cacheWriteTokens: number, cacheWrite1hTokens: number) => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens,
  cacheWrite1hTokens
})

test('5-minute writes keep the 1.25x rate', () => {
  expect(computeCosts(row(1_000_000, 0), PRICES).totalCostUsd).toBeCloseTo(12.5, 6)
})

test('1-hour writes are priced at 2x', () => {
  expect(computeCosts(row(1_000_000, 1_000_000), PRICES).totalCostUsd).toBeCloseTo(20, 6)
})

test('a mixed total is split, not double counted', () => {
  // 600k at 1h ($12) + 400k at 5m ($5).
  expect(computeCosts(row(1_000_000, 600_000), PRICES).totalCostUsd).toBeCloseTo(17, 6)
})

test('a 1-hour share larger than the total is clamped to it', () => {
  expect(computeCosts(row(100_000, 900_000), PRICES).totalCostUsd).toBeCloseTo(2, 6)
})

test('an unpriced model stays unpriced', () => {
  expect(computeCosts({ ...row(1_000_000, 500_000), model: 'unknown' }, PRICES).totalCostUsd).toBeNull()
})

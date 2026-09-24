/**
 * The Long context threshold in effect: the tuned value when there is one,
 * kept within [30k, base], else the automatic base.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  effectiveLongContextThreshold,
  LONG_CONTEXT_FLOOR,
  longContextBase
} from '../../../src/llms/tier-router/threshold'

describe('longContextBase', () => {
  test("is 70% of the default model's window, leaving the reply room", () => {
    expect(longContextBase(1_000_000)).toBe(700_000)
    expect(longContextBase(200_000)).toBe(140_000)
  })

  test('falls back to 128k when no default route resolves to a known window', () => {
    expect(longContextBase(null)).toBe(DEFAULT_LONG_CONTEXT_THRESHOLD)
  })
})

describe('effectiveLongContextThreshold', () => {
  test('nothing stored reads as the base', () => {
    expect(effectiveLongContextThreshold(null, 700_000)).toBe(700_000)
  })

  test('a tuned value inside the range is used as is', () => {
    expect(effectiveLongContextThreshold(448_000, 700_000)).toBe(448_000)
  })

  test('never above the base: a default model swapped for a smaller one pulls it down', () => {
    expect(effectiveLongContextThreshold(700_000, 140_000)).toBe(140_000)
  })

  test('never below the floor', () => {
    expect(effectiveLongContextThreshold(10_000, 700_000)).toBe(LONG_CONTEXT_FLOOR)
  })

  test('a base under the floor wins over the floor', () => {
    expect(effectiveLongContextThreshold(10_000, 20_000)).toBe(20_000)
  })
})

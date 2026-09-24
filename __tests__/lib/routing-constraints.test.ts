/**
 * The Routing screen's constraint cells: how an edit lands on the
 * profile's constraints, and which typed text counts as a value.
 */

import { describe, expect, test } from 'bun:test'
import {
  applyConstraintEdit,
  DEFAULT_CONSTRAINTS,
  errorRatePctOf,
  parseSampleCount,
  parseWholePercent
} from '../../src/components/rialto/routing/derive'

describe('applying an edit', () => {
  test('each cell writes its own knob and leaves the other three alone', () => {
    expect(applyConstraintEdit(DEFAULT_CONSTRAINTS, { kind: 'exhaustedBehavior', value: 'passthrough' })).toEqual({
      ...DEFAULT_CONSTRAINTS,
      exhaustedBehavior: 'passthrough'
    })
    expect(applyConstraintEdit(DEFAULT_CONSTRAINTS, { kind: 'quotaSkipPct', value: 80 })).toEqual({
      ...DEFAULT_CONSTRAINTS,
      quotaSkipPct: 80
    })
    expect(applyConstraintEdit(DEFAULT_CONSTRAINTS, { kind: 'minHealthSamples', value: 12 })).toEqual({
      ...DEFAULT_CONSTRAINTS,
      minHealthSamples: 12
    })
  })

  test('the error rate is edited as a percentage and stored as the fraction the router compares', () => {
    const edited = applyConstraintEdit(DEFAULT_CONSTRAINTS, { kind: 'errorRateSkipPct', value: 25 })
    expect(edited.errorRateSkipPct).toBe(0.25)
    expect(errorRatePctOf(edited)).toBe(25)
  })

  test('the default fraction reads as the percentage the cell shows', () => {
    expect(errorRatePctOf(DEFAULT_CONSTRAINTS)).toBe(50)
  })

  test('the edit does not mutate the constraints it was applied to', () => {
    const before = { ...DEFAULT_CONSTRAINTS }
    applyConstraintEdit(before, { kind: 'quotaSkipPct', value: 10 })
    expect(before).toEqual(DEFAULT_CONSTRAINTS)
  })
})

describe('parseWholePercent', () => {
  test('accepts a whole percentage from 0 to 100', () => {
    expect(parseWholePercent('0')).toBe(0)
    expect(parseWholePercent('100')).toBe(100)
    expect(parseWholePercent(' 42 ')).toBe(42)
  })

  test('refuses anything else', () => {
    for (const text of ['', '101', '5.5', '-1', 'abc', '1000']) {
      expect(parseWholePercent(text)).toBeNull()
    }
  })
})

describe('parseSampleCount', () => {
  test('accepts a non-negative whole number', () => {
    expect(parseSampleCount('0')).toBe(0)
    expect(parseSampleCount('5')).toBe(5)
    expect(parseSampleCount(' 250 ')).toBe(250)
  })

  test('refuses fractions, negatives, words and absurd sizes', () => {
    for (const text of ['', '2.5', '-1', 'five', '1234567']) {
      expect(parseSampleCount(text)).toBeNull()
    }
  })
})

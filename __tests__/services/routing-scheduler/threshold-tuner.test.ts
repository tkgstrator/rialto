/**
 * The Long context tuner's decisions, one rule at a time.
 *
 * It runs unattended on a live install and every change it gets wrong
 * moves traffic between quotas quietly, so each guard is pinned here.
 */

import { describe, expect, test } from 'bun:test'
import {
  TUNE_INTERVAL_MS,
  type TuneInput,
  tuneThreshold
} from '../../../src/services/routing-scheduler/threshold-tuner'

const NOW = 1_800_000_000_000
const BASE = 700_000

const input = (over: Partial<TuneInput> = {}): TuneInput => ({
  current: BASE,
  base: BASE,
  stored: null,
  previous: null,
  tunedAt: null,
  now: NOW,
  target: { projectedPct: 80, exhausted: false },
  ...over
})

describe('tuneThreshold', () => {
  test('a Long context route on pace to end with quota left lowers the threshold by 20%', () => {
    expect(tuneThreshold(input({ target: { projectedPct: 40, exhausted: false } }))).toEqual({
      threshold: 560_000,
      previous: BASE,
      reason: 'lowered'
    })
  })

  test('one on pace to run out raises it by 20%, up to the base', () => {
    expect(
      tuneThreshold(input({ current: 448_000, stored: 448_000, target: { projectedPct: 130, exhausted: false } }))
    ).toEqual({
      threshold: 537_600,
      previous: 448_000,
      reason: 'raised'
    })
    expect(
      tuneThreshold(input({ current: 650_000, stored: 650_000, target: { projectedPct: 130, exhausted: false } }))
    ).toEqual({
      threshold: BASE,
      previous: 650_000,
      reason: 'raised'
    })
  })

  test('already at the base, an over-pace route changes nothing', () => {
    expect(tuneThreshold(input({ target: { projectedPct: 130, exhausted: false } }))).toBeNull()
  })

  test('never below 30k', () => {
    expect(
      tuneThreshold(input({ current: 35_000, stored: 35_000, target: { projectedPct: 10, exhausted: false } }))
    ).toEqual({
      threshold: 30_000,
      previous: 35_000,
      reason: 'lowered'
    })
    expect(
      tuneThreshold(input({ current: 30_000, stored: 30_000, target: { projectedPct: 10, exhausted: false } }))
    ).toBeNull()
  })

  test('on pace — between 60% and 100% — leaves it alone', () => {
    expect(tuneThreshold(input({ target: { projectedPct: 60, exhausted: false } }))).toBeNull()
    expect(tuneThreshold(input({ target: { projectedPct: 100, exhausted: false } }))).toBeNull()
  })

  test('no pace reading, or no Long context route, leaves it alone', () => {
    expect(tuneThreshold(input({ target: { projectedPct: null, exhausted: false } }))).toBeNull()
    expect(tuneThreshold(input({ target: undefined }))).toBeNull()
  })

  test('at most one change a day', () => {
    const recent = { tunedAt: NOW - TUNE_INTERVAL_MS + 60_000, stored: 560_000, current: 560_000, previous: BASE }
    expect(tuneThreshold(input({ ...recent, target: { projectedPct: 10, exhausted: false } }))).toBeNull()
    const dayOld = { ...recent, tunedAt: NOW - TUNE_INTERVAL_MS }
    expect(tuneThreshold(input({ ...dayOld, target: { projectedPct: 10, exhausted: false } }))?.reason).toBe('lowered')
  })

  test('a lowering the route could not carry — it ran out within the day — is rolled back', () => {
    const lowered = { tunedAt: NOW - 3_600_000, stored: 560_000, current: 560_000, previous: BASE }
    expect(tuneThreshold(input({ ...lowered, target: { projectedPct: 110, exhausted: true } }))).toEqual({
      threshold: BASE,
      previous: null,
      reason: 'rolled back'
    })
  })

  test('running out after a raise is not rolled back: raising was already the answer to running out', () => {
    const raised = { tunedAt: NOW - 3_600_000, stored: 537_600, current: 537_600, previous: 448_000 }
    expect(tuneThreshold(input({ ...raised, target: { projectedPct: 120, exhausted: true } }))).toBeNull()
  })
})

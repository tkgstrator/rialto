import { describe, expect, test } from 'bun:test'
import { PACE_MIN_ELAPSED, windowProjectedPct } from '../../src/shared/quota-pace'

const NOW = Date.UTC(2026, 8, 1)
const HOUR = 3_600_000
const LENGTH = 5 * HOUR

const project = (used: number, elapsed: number, length = LENGTH): number | null =>
  windowProjectedPct(used, NOW + (1 - elapsed) * length, length, NOW)

describe('windowProjectedPct', () => {
  test('projects use at the reset without capping values above 100%', () => {
    expect(project(60, 0.5)).toBe(120)
    expect(project(25, 0.5)).toBe(50)
  })

  test('does not judge before the warm-up but judges at its boundary', () => {
    expect(project(8, PACE_MIN_ELAPSED / 2)).toBeNull()
    expect(project(8, PACE_MIN_ELAPSED)).toBeCloseTo(80)
  })

  test('uses the reported Codex duration rather than assuming five hours', () => {
    expect(project(20, 0.5, HOUR)).toBe(40)
  })

  test('leaves missing, expired and invalid windows unknown', () => {
    expect(windowProjectedPct(30, null, LENGTH, NOW)).toBeNull()
    expect(windowProjectedPct(30, NOW + HOUR, null, NOW)).toBeNull()
    expect(windowProjectedPct(30, NOW - HOUR, LENGTH, NOW)).toBeNull()
    expect(windowProjectedPct(30, NOW + HOUR, 0, NOW)).toBeNull()
    expect(windowProjectedPct(Number.NaN, NOW + HOUR, LENGTH, NOW)).toBeNull()
  })
})

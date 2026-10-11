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

  test('projects early usage without waiting for a tenth of the window', () => {
    expect(project(8, 0.05)).toBeCloseTo(160)
    expect(project(10, 0.01)).toBeCloseTo(1000)
    expect(project(0, 0.01)).toBe(0)
    expect(project(90, 0.05, 7 * 24 * HOUR)).toBeCloseTo(1800)
  })

  test('keeps the routing warm-up when explicitly requested', () => {
    expect(windowProjectedPct(8, NOW + 0.95 * LENGTH, LENGTH, NOW, PACE_MIN_ELAPSED)).toBeNull()
    expect(windowProjectedPct(8, NOW + 0.9 * LENGTH, LENGTH, NOW, PACE_MIN_ELAPSED)).toBeCloseTo(80)
  })

  test('leaves the exact start and future windows unknown instead of dividing by zero', () => {
    expect(project(8, 0)).toBeNull()
    expect(project(0, 0)).toBeNull()
    expect(project(8, -0.01)).toBeNull()
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

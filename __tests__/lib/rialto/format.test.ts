import { describe, expect, test } from 'bun:test'
import { fmtAgo, fmtCount, fmtLatency, fmtRate, fmtUntil, shortId } from '../../../src/lib/rialto/format'

// A fixed "now" so the assertions never depend on wall-clock drift.
const NOW = Date.parse('2026-08-31T12:00:00.000Z')
const at = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString()

describe('fmtAgo', () => {
  test('steps through seconds, minutes, hours, days', () => {
    expect(fmtAgo(at(-30), NOW)).toBe('30s')
    expect(fmtAgo(at(-120), NOW)).toBe('2m')
    expect(fmtAgo(at(-3 * 3600), NOW)).toBe('3h')
    expect(fmtAgo(at(-50 * 3600), NOW)).toBe('2d')
  })

  test('clamps a future timestamp to zero rather than showing a negative', () => {
    expect(fmtAgo(at(60), NOW)).toBe('0s')
  })

  test('returns a dash for an unparseable timestamp', () => {
    expect(fmtAgo('not-a-date', NOW)).toBe('–')
  })
})

describe('fmtUntil', () => {
  test('renders two units of precision above an hour', () => {
    expect(fmtUntil(at(2 * 3600 + 11 * 60), NOW)).toBe('2h 11m')
    expect(fmtUntil(at(3 * 86400 + 4 * 3600), NOW)).toBe('3d 04h')
  })

  test('rounds up inside the hour so a due-soon window never reads 0m', () => {
    expect(fmtUntil(at(46 * 60), NOW)).toBe('46m')
    expect(fmtUntil(at(30), NOW)).toBe('1m')
  })

  test('reports an elapsed or missing reset without a negative duration', () => {
    // Null, not a word: an elapsed window has no duration left to name, and
    // the caller owns the wording so it can be translated. Returning 'now'
    // put "resets in now" on screen in English and an untranslated "now" in
    // the JA and ZH builds.
    expect(fmtUntil(at(-60), NOW)).toBeNull()
    expect(fmtUntil(null, NOW)).toBe('–')
  })
})

describe('fmtCount', () => {
  test('switches unit at each thousand boundary', () => {
    expect(fmtCount(486)).toBe('486')
    expect(fmtCount(3100)).toBe('3.1k')
    expect(fmtCount(12_400)).toBe('12.4k')
    expect(fmtCount(1_200_000)).toBe('1.20M')
  })
})

describe('fmtLatency', () => {
  test('uses seconds above 1s and milliseconds below', () => {
    expect(fmtLatency(1900)).toBe('1.9s')
    expect(fmtLatency(840)).toBe('840ms')
  })

  test('distinguishes no-traffic from zero latency', () => {
    expect(fmtLatency(null)).toBe('–')
    expect(fmtLatency(0)).toBe('0ms')
  })
})

describe('fmtRate', () => {
  test('renders one decimal, and a dash when there is no traffic to rate', () => {
    expect(fmtRate(0.002)).toBe('0.2%')
    expect(fmtRate(0)).toBe('0.0%')
    expect(fmtRate(null)).toBe('–')
  })
})

describe('shortId', () => {
  test('elides the middle of a long id and leaves short ones alone', () => {
    expect(shortId('ses_9fa2b1c3d4e5f6c41')).toBe('ses_9fa2…c41')
    expect(shortId('ses_short')).toBe('ses_short')
  })
})

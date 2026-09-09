import { describe, expect, test } from 'bun:test'
import { fmtAgo, fmtCount, fmtLatency, fmtRate, fmtUntil, fmtUptime, shortId } from '../../../src/lib/rialto/format'

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

describe('fmtUptime', () => {
  test('reads as a duration rather than a raw second count', () => {
    // The number the Health tab used to print verbatim.
    expect(fmtUptime(2232)).toBe('37m 12s')
    expect(fmtUptime(7 * 86400 + 11 * 3600 + 10 * 60)).toBe('7d 11h 10m')
  })

  test('drops a unit at each threshold so the value stays two or three wide', () => {
    expect(fmtUptime(42)).toBe('42s')
    expect(fmtUptime(60)).toBe('1m 00s')
    expect(fmtUptime(3600)).toBe('1h 00m')
    expect(fmtUptime(3 * 3600 + 24 * 60 + 59)).toBe('3h 24m')
    expect(fmtUptime(86400)).toBe('1d 00h 00m')
  })

  test('pads the secondary units so the column stays aligned', () => {
    expect(fmtUptime(7 * 86400 + 3600 + 5 * 60)).toBe('7d 01h 05m')
  })

  test('clamps a negative or fractional input instead of rendering it', () => {
    expect(fmtUptime(-5)).toBe('0s')
    expect(fmtUptime(90.9)).toBe('1m 30s')
  })
})

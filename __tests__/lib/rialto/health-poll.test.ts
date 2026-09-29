/**
 * The unreachable screen's poll.
 *
 * With the dev database empty, /health passed (SELECT 1 needs no tables)
 * while /api/config failed on a missing table, and the screen retried the
 * config after every probe with no delay between them. Each retry was a
 * Postgres query and a logged stack trace. These pin the two rules that
 * stop it: the config is retried once per recovery, and the poll slows.
 */
import { describe, expect, test } from 'bun:test'
import { canServe, pollDelay, shouldRetryConfig } from '../../../src/components/rialto/system/health-poll'
import type { HealthResponse } from '../../../src/lib/api'

const health = (db: 'ok' | 'fail' | 'skip'): HealthResponse => ({
  status: db === 'fail' ? 'degraded' : 'ok',
  version: '0.0.0',
  uptime_seconds: 1,
  checks: { db, redis: 'skip' }
})

// Replays a run of probes the way the screen does and returns which ones
// retried the config.
const retries = (probes: ReadonlyArray<HealthResponse | null>): boolean[] =>
  probes.reduce<{ couldServe: boolean; out: boolean[] }>(
    (acc, probe) => {
      const now = canServe(probe)
      return { couldServe: now, out: [...acc.out, shouldRetryConfig(acc.couldServe, now)] }
    },
    { couldServe: false, out: [] }
  ).out

describe('canServe', () => {
  test('an unreachable server cannot', () => {
    expect(canServe(null)).toBe(false)
  })

  test('a 503 body with the database failing cannot, though /health answered', () => {
    expect(canServe(health('fail'))).toBe(false)
  })

  test('a passing or unwired database can', () => {
    expect(canServe(health('ok'))).toBe(true)
    expect(canServe(health('skip'))).toBe(true)
  })
})

describe('shouldRetryConfig', () => {
  test('health keeps passing while the config keeps failing: one retry, not one per probe', () => {
    expect(retries([health('ok'), health('ok'), health('ok'), health('ok')])).toEqual([true, false, false, false])
  })

  test('no retry while the database is down, one when it comes back', () => {
    expect(retries([null, health('fail'), health('fail'), health('ok'), health('ok')])).toEqual([
      false,
      false,
      false,
      true,
      false
    ])
  })

  test('each recovery gets its own retry', () => {
    expect(retries([health('ok'), health('fail'), health('ok')])).toEqual([true, false, true])
  })
})

describe('pollDelay', () => {
  test('doubles from five seconds and stops at a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(pollDelay)).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
  })
})

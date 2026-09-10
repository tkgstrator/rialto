/**
 * The Requests screen's stat tiles, and the window its table is drawn
 * from.
 *
 * Both used to be page-shaped. The tiles were folded in the browser from
 * whatever the table was showing — 25 rows — under labels that promised
 * "last 24h", and the list endpoint had no time filter at all, so
 * `total` was the size of the whole archive no matter which range was
 * selected. Nothing about either was visible as a failure; the numbers
 * were simply about a different population than the one named.
 *
 * These are DB-backed because the aggregate is SQL: the percentiles come
 * from `percentile_cont`, and a fold written in TypeScript here would
 * pin the wrong thing.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { requestLogsRoute } from '../../src/api/request-logs/route'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

interface Stats {
  total: number
  ok: number
  rateLimited: number
  failed: number
  p50: number | null
  p95: number | null
}

const app = (): Hono => {
  const instance = new Hono()
  instance.route('/', requestLogsRoute)
  return instance
}

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app().fetch(new Request(`http://local${url}`))
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

const stats = (sinceHours: number): Promise<Stats> => getJson<Stats>(`/api/request-logs/stats?sinceHours=${sinceHours}`)

const SESSION = 'sess-stats'

/**
 * One logged call. `hoursAgo` places it relative to now so a test can
 * straddle a window boundary; `durationMs` of 0 marks a request that
 * never reached an upstream.
 */
const log = (over: { hoursAgo: number; status: number; durationMs: number }) => ({
  sessionId: SESSION,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  status: over.status,
  durationMs: over.durationMs,
  createdAt: dayjs().subtract(over.hoursAgo, 'hour').toDate()
})

const seed = async (rows: { hoursAgo: number; status: number; durationMs: number }[]): Promise<void> => {
  const prisma = getPrismaClient()
  await prisma.session.create({ data: { id: SESSION } })
  await prisma.requestLog.createMany({ data: rows.map(log) })
}

describe.if(HAS_DB)('request-log window stats', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('counts the whole window, not one page of it', async () => {
    // 60 rows is more than the screen's page size, which is the entire
    // point: a fold over the page could never see past the first 25.
    await seed(Array.from({ length: 60 }, () => ({ hoursAgo: 1, status: 200, durationMs: 100 })))
    const s = await stats(24)
    expect(s.total).toBe(60)
    expect(s.ok).toBe(60)
  })

  test('splits the status mix', async () => {
    await seed([
      { hoursAgo: 1, status: 200, durationMs: 100 },
      { hoursAgo: 1, status: 201, durationMs: 100 },
      { hoursAgo: 1, status: 429, durationMs: 0 },
      { hoursAgo: 1, status: 400, durationMs: 50 },
      { hoursAgo: 1, status: 500, durationMs: 50 }
    ])
    const s = await stats(24)
    expect(s.total).toBe(5)
    expect(s.ok).toBe(2)
    // A 429 is a failover, not an error the client saw, so it is counted
    // on its own and kept out of the 4xx/5xx tile.
    expect(s.rateLimited).toBe(1)
    expect(s.failed).toBe(2)
  })

  test('a row outside the window is excluded', async () => {
    await seed([
      { hoursAgo: 1, status: 200, durationMs: 100 },
      { hoursAgo: 48, status: 500, durationMs: 100 }
    ])
    const day = await stats(24)
    expect(day.total).toBe(1)
    expect(day.failed).toBe(0)
    // The same rows over a wider window — proof the row exists and it is
    // the cutoff doing the work.
    const week = await stats(168)
    expect(week.total).toBe(2)
    expect(week.failed).toBe(1)
  })

  test('sinceHours 0 covers the whole archive', async () => {
    await seed([
      { hoursAgo: 1, status: 200, durationMs: 100 },
      { hoursAgo: 5_000, status: 200, durationMs: 100 }
    ])
    expect((await stats(0)).total).toBe(2)
  })

  test('percentiles come from the window and ignore rows that never dispatched', async () => {
    await seed([
      ...[10, 20, 30, 40, 50].map((durationMs) => ({ hoursAgo: 1, status: 200, durationMs })),
      // Refused before dispatch: it has no latency to contribute, and
      // counting it as 0ms would drag the median toward a number no
      // request actually took.
      { hoursAgo: 1, status: 429, durationMs: 0 }
    ])
    const s = await stats(24)
    expect(s.total).toBe(6)
    expect(s.p50).toBe(30)
    expect(s.p95).toBe(48)
  })

  test('an empty window has no percentile rather than a zero one', async () => {
    await seed([{ hoursAgo: 48, status: 200, durationMs: 100 }])
    const s = await stats(24)
    expect(s.total).toBe(0)
    expect(s.p50).toBeNull()
    expect(s.p95).toBeNull()
  })

  test('a window of nothing but 429s has no percentile', async () => {
    await seed([
      { hoursAgo: 1, status: 429, durationMs: 0 },
      { hoursAgo: 1, status: 429, durationMs: 0 }
    ])
    const s = await stats(24)
    expect(s.rateLimited).toBe(2)
    expect(s.p50).toBeNull()
  })
})

describe.if(HAS_DB)('request-log list window', () => {
  beforeEach(async () => {
    await resetDbTables()
  })

  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('total counts the window the page is drawn from', async () => {
    await seed([
      { hoursAgo: 1, status: 200, durationMs: 100 },
      { hoursAgo: 2, status: 200, durationMs: 100 },
      { hoursAgo: 48, status: 200, durationMs: 100 }
    ])
    // Previously 3 for every range: the endpoint had no time filter, so
    // "N of M in the last 24h" took its two halves from two populations.
    const day = await getJson<{ items: unknown[]; total: number }>('/api/request-logs?limit=25&sinceHours=24')
    expect(day.total).toBe(2)
    expect(day.items).toHaveLength(2)

    const all = await getJson<{ items: unknown[]; total: number }>('/api/request-logs?limit=25&sinceHours=0')
    expect(all.total).toBe(3)
  })

  test('omitting sinceHours still covers the whole archive', async () => {
    await seed([
      { hoursAgo: 1, status: 200, durationMs: 100 },
      { hoursAgo: 48, status: 200, durationMs: 100 }
    ])
    // Callers that only want the archive's size keep the answer they had.
    const res = await getJson<{ total: number }>('/api/request-logs?limit=1')
    expect(res.total).toBe(2)
  })
})

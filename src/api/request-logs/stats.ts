/**
 * Window aggregate for the Requests screen's stat tiles.
 *
 * The tiles used to be computed in the browser from whatever page the
 * table happened to be showing, so "Requests / last 24h" was really
 * "requests among the newest 25 rows" — and the 2xx share, the 429 count
 * and the latency percentiles were all drawn from that same 25. On a
 * busy install the tiles were describing a sliver of a second's traffic
 * under a label that promised a day of it.
 *
 * Aggregating in Postgres rather than fetching the window and folding it
 * here is not an optimisation, it is the only version that stays correct:
 * a 24-hour window can hold more rows than any request should carry, so
 * any client-side fold has to cap, and a capped fold is the bug this
 * replaces.
 */

import { createRoute } from '@hono/zod-openapi'
import { getPrismaClient } from '../../db/client'
import dayjs from '../../lib/dayjs'
import { RequestLogStatsQuerySchema, RequestLogStatsResponseSchema } from '../../schemas/api/request-log'
import { requestLogsRoute } from './app'

// One row, already reduced. Counts are cast to `int` in SQL because
// `count(*)` is a bigint, which arrives as a JS BigInt that JSON cannot
// serialise. The percentiles come back as double precision, or null when
// the FILTER matched nothing.
interface StatsRow {
  total: number
  ok: number
  rate_limited: number
  failed: number
  p50: number | null
  p95: number | null
}

// `durationMs` is 0 on a request that never reached an upstream (a 429
// refused before dispatch, a rejected body), so those rows are excluded
// from the percentiles while still counting toward the status mix. The
// FILTER lives on the ordered-set aggregate rather than in the WHERE
// clause precisely so the two populations can differ.
const P50 = 0.5
const P95 = 0.95

// ── GET /api/request-logs/stats ───────────────────────────────────────────────

const getRequestLogStatsRoute = createRoute({
  method: 'get',
  path: '/api/request-logs/stats',
  request: { query: RequestLogStatsQuerySchema },
  responses: {
    200: {
      description: 'Status mix and latency spread across a time window.',
      content: { 'application/json': { schema: RequestLogStatsResponseSchema } }
    }
  }
})

requestLogsRoute.openapi(getRequestLogStatsRoute, async (c) => {
  const { sinceHours } = c.req.valid('query')
  const prisma = getPrismaClient()

  // Two spellings rather than a computed cutoff for the unbounded case:
  // `sinceHours: 0` means the whole archive, and a WHERE clause of
  // `>= epoch` would read as a bound that happens to admit everything.
  const rows =
    sinceHours === 0
      ? await prisma.$queryRaw<StatsRow[]>`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE status >= 200 AND status < 300)::int AS ok,
            count(*) FILTER (WHERE status = 429)::int AS rate_limited,
            count(*) FILTER (WHERE status >= 400 AND status <> 429)::int AS failed,
            percentile_cont(${P50}) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE "durationMs" > 0) AS p50,
            percentile_cont(${P95}) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE "durationMs" > 0) AS p95
          FROM "RequestLog"
        `
      : await prisma.$queryRaw<StatsRow[]>`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE status >= 200 AND status < 300)::int AS ok,
            count(*) FILTER (WHERE status = 429)::int AS rate_limited,
            count(*) FILTER (WHERE status >= 400 AND status <> 429)::int AS failed,
            percentile_cont(${P50}) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE "durationMs" > 0) AS p50,
            percentile_cont(${P95}) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE "durationMs" > 0) AS p95
          FROM "RequestLog"
          WHERE "createdAt" >= ${dayjs().subtract(sinceHours, 'hour').toDate()}
        `

  // An aggregate over no rows still returns one row, so this is only
  // defensive against a driver that hands back none.
  const row = rows[0]
  if (row === undefined) {
    return c.json({ total: 0, ok: 0, rateLimited: 0, failed: 0, p50: null, p95: null }, 200)
  }
  return c.json(
    {
      total: row.total,
      ok: row.ok,
      rateLimited: row.rate_limited,
      failed: row.failed,
      p50: row.p50,
      p95: row.p95
    },
    200
  )
})

/** Query orchestration for the Overview screen. */
import { z } from 'zod'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'
import { type AccountUsage, usageByAccount } from './account-usage-service'
import { buildPriceMap } from './cost-service'
import { listSurfaces } from './inbound-surface-service'
import {
  buildFailover,
  buildQuota,
  buildRecentSessions,
  buildSpend,
  buildSurfaces,
  SPEND_PERIODS,
  type SpendBucket,
  type SurfaceStat,
  spendWindows,
  type WindowLog
} from './overview-builders'
import type { OverviewResponse } from './overview-types'

export type {
  FailoverRow,
  OverviewResponse,
  QuotaRow,
  QuotaWindowRow,
  RecentSessionRow,
  SpendRow,
  SurfaceTrafficRow
} from './overview-types'

const priceKey = (provider: string, model: string): string => `${provider}||${model}`

// Raw rows are unknown until parsed; the sums come back as double
// precision so they land as JS numbers rather than BigInt.
const SpendBucketSchema = z.object({
  label: z.enum(SPEND_PERIODS),
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheWrite1hTokens: z.number()
})

const SurfaceStatRowSchema = z.object({
  surface: z.string().nonempty(),
  requests: z.number(),
  p50: z.number().nullable(),
  errorRate: z.number().nullable()
})

const RecentSessionRowSchema = z.object({
  sessionId: z.string().nonempty(),
  surface: z.string().nullable(),
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  durationMs: z.number(),
  status: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheWrite1hTokens: z.number(),
  totalInputTokens: z.number(),
  createdAt: z.date()
})

/**
 * Per-surface traffic aggregate, computed in Postgres.
 *
 * The screen only needs three numbers per surface (count, median
 * latency, error share) over `windowHours` of RequestLog, but the
 * original code fetched every row in the window to compute them in JS.
 * At even a modest ~1 req/sec that is 86 400 rows per load, serialized
 * over the wire, whatever the operator actually looks at. One GROUP BY
 * with `percentile_cont` is the same answer and leaves the rows in the
 * database.
 *
 * `surface IS NOT NULL` keeps rows written before the column landed out
 * of the aggregate — the screen does not bucket untracked traffic into
 * a surface, and the Surface test pins that.
 */
async function loadSurfaceStats(since: Date): Promise<Map<string, SurfaceStat>> {
  const rows = await getPrismaClient().$queryRaw`
    SELECT surface AS surface,
           COUNT(*)::double precision AS requests,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")::double precision AS p50,
           (COUNT(*) FILTER (WHERE status < 200 OR status >= 300))::double precision
             / NULLIF(COUNT(*), 0)::double precision AS "errorRate"
    FROM "RequestLog"
    WHERE "createdAt" >= ${since}::timestamptz
      AND surface IS NOT NULL
    GROUP BY surface
  `
  const parsed = z.array(SurfaceStatRowSchema).safeParse(rows)
  if (!parsed.success) throw new Error('surface aggregate did not match the expected shape')
  const out = new Map<string, SurfaceStat>()
  for (const r of parsed.data) {
    out.set(r.surface, {
      requests: r.requests,
      // JS median rounded to int on the two-element case; `percentile_cont`
      // returns the same interpolation, rounded here so SurfaceTrafficRow
      // keeps its int shape.
      p50Ms: r.p50 === null ? null : Math.round(r.p50),
      errorRate: r.errorRate
    })
  }
  return out
}

/**
 * Row-level data for just the sessions the recent-session table renders.
 *
 * The screen shows eight entries; the old query fetched every row in the
 * window to drop all but the first eight sessions. Restricting the scan
 * to those sessions' rows (picked in SQL by MAX(createdAt)) keeps the
 * per-session aggregate exact — buildRecentSessions walks the rows and
 * prices each (provider, model) sub-group — without pulling the window.
 */
async function loadRecentSessionLogs(since: Date): Promise<WindowLog[]> {
  const rows = await getPrismaClient().$queryRaw`
    WITH recent AS (
      SELECT "sessionId", MAX("createdAt") AS last_at
      FROM "RequestLog"
      WHERE "createdAt" >= ${since}::timestamptz
      GROUP BY "sessionId"
      ORDER BY last_at DESC
      LIMIT 8
    )
    SELECT r."sessionId" AS "sessionId",
           r.surface AS surface,
           r.provider AS provider,
           r.model AS model,
           r."durationMs"::double precision AS "durationMs",
           r.status::double precision AS status,
           r."inputTokens"::double precision AS "inputTokens",
           r."outputTokens"::double precision AS "outputTokens",
           r."cacheReadTokens"::double precision AS "cacheReadTokens",
           r."cacheWriteTokens"::double precision AS "cacheWriteTokens",
           r."cacheWrite1hTokens"::double precision AS "cacheWrite1hTokens",
           r."totalInputTokens"::double precision AS "totalInputTokens",
           r."createdAt" AS "createdAt"
    FROM "RequestLog" r
    JOIN recent USING ("sessionId")
    WHERE r."createdAt" >= ${since}::timestamptz
    ORDER BY r."createdAt" DESC
  `
  const parsed = z.array(RecentSessionRowSchema).safeParse(rows)
  if (!parsed.success) throw new Error('recent-session rows did not match the expected shape')
  return parsed.data
}

export function loadQuotas() {
  return getPrismaClient().subAccountQuota.findMany({
    include: {
      subAccount: {
        select: { id: true, label: true, plan: true, monthlyPriceUsd: true, provider: { select: { name: true } } }
      }
    }
  })
}

/**
 * Sum the spend periods in Postgres instead of in this process.
 *
 * The six periods overlap (today is inside week is inside month), so a
 * row belongs to several of them and a plain GROUP BY cannot express it.
 * Joining against the period list fans each row out to the periods that
 * contain it, and the `createdAt >= earliest` predicate still lets the
 * index restrict the scan to the outermost period — one pass over 60
 * days, rather than one query per period re-reading the nested ranges.
 */
async function loadSpendBuckets(
  windows: Array<{ label: (typeof SPEND_PERIODS)[number]; from: Date; to: Date }>
): Promise<SpendBucket[]> {
  const earliest = windows.reduce((min, w) => (w.from < min ? w.from : min), windows[0].from)
  const rows = await getPrismaClient().$queryRaw`
    SELECT p.label AS label,
           r.provider AS provider,
           r.model AS model,
           SUM(r."inputTokens")::double precision AS "inputTokens",
           SUM(r."outputTokens")::double precision AS "outputTokens",
           SUM(r."cacheReadTokens")::double precision AS "cacheReadTokens",
           SUM(r."cacheWriteTokens")::double precision AS "cacheWriteTokens",
           SUM(r."cacheWrite1hTokens")::double precision AS "cacheWrite1hTokens"
    FROM "RequestLog" r
    JOIN (VALUES
            (${windows[0].label}, ${windows[0].from}::timestamptz, ${windows[0].to}::timestamptz),
            (${windows[1].label}, ${windows[1].from}::timestamptz, ${windows[1].to}::timestamptz),
            (${windows[2].label}, ${windows[2].from}::timestamptz, ${windows[2].to}::timestamptz),
            (${windows[3].label}, ${windows[3].from}::timestamptz, ${windows[3].to}::timestamptz),
            (${windows[4].label}, ${windows[4].from}::timestamptz, ${windows[4].to}::timestamptz),
            (${windows[5].label}, ${windows[5].from}::timestamptz, ${windows[5].to}::timestamptz)
         ) AS p(label, "from", "to")
      ON r."createdAt" >= p."from" AND r."createdAt" < p."to"
    WHERE r."createdAt" >= ${earliest}::timestamptz
    GROUP BY p.label, r.provider, r.model
  `
  // A shape mismatch here means the query and the schema have drifted
  // apart, which would otherwise surface as silently missing spend
  // rather than a fault anyone can act on.
  const parsed = z.array(SpendBucketSchema).safeParse(rows)
  if (!parsed.success) throw new Error('spend aggregate did not match the expected shape')
  return parsed.data
}

export async function getOverview(windowHours: number): Promise<OverviewResponse> {
  const prisma = getPrismaClient()
  const since = dayjs().subtract(windowHours, 'hour').toDate()
  // 60 days, not 30: every spend tile compares against the equally long
  // period before it, and the month tile's predecessor reaches back 60.
  const windows = spendWindows(dayjs())

  const [surfaceConfigs, providerCount, enabledModelCount, surfaceStats, sessionLogs, spendBuckets, quotas, rejected] =
    await Promise.all([
      listSurfaces(),
      prisma.provider.count(),
      prisma.model.count({ where: { enabled: true } }),
      loadSurfaceStats(since),
      loadRecentSessionLogs(since),
      loadSpendBuckets(windows),
      loadQuotas(),
      // Switched-off providers are left out: a credential nobody routes
      // through is not a failover event.
      prisma.subAccount.findMany({
        where: { authStatus: 'invalid', provider: { enabled: true } },
        orderBy: { authCheckedAt: 'desc' },
        take: 6,
        select: { label: true, authCheckedAt: true, authError: true, provider: { select: { name: true } } }
      })
    ])

  // Session rows carry (provider, model) too, so their pairs must price
  // alongside the spend aggregate's — otherwise a session on a model that
  // did not land in any spend bucket would read as unpriced.
  const pricePairs = new Set<string>(spendBuckets.map((b) => priceKey(b.provider, b.model)))
  for (const row of sessionLogs) pricePairs.add(priceKey(row.provider, row.model))
  const priceMap = await buildPriceMap(prisma, [...pricePairs])
  // Per-account usage is an addition to the quota rows, not a condition
  // of them: if the aggregate fails, the windows still render and the
  // usage lines say they could not be read.
  const usage = await usageByAccount(
    quotas.map((q) => ({
      subAccountId: q.subAccountId,
      weeklyResetAt: q.weeklyResetAt,
      weeklyWindowSeconds: q.weeklyWindowSeconds,
      monthlyPriceUsd: q.subAccount.monthlyPriceUsd
    }))
  ).catch((err: unknown) => {
    logger.warn({ err }, '[overview] per-account usage aggregate failed')
    return new Map<string, AccountUsage>()
  })

  return {
    windowHours,
    generatedAt: dayjs().toISOString(),
    providerCount,
    enabledModelCount,
    surfaces: buildSurfaces(surfaceConfigs, surfaceStats),
    spend: buildSpend(spendBuckets, priceMap),
    quota: buildQuota(quotas, usage),
    failover: buildFailover(quotas, rejected),
    recentSessions: buildRecentSessions(sessionLogs, priceMap)
  }
}

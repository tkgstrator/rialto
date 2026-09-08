/**
 * Aggregations for the Overview screen.
 *
 * One query pass over a bounded window of `RequestLog`, plus the current
 * quota snapshot and the recent scheduler weight changes. Everything the
 * screen shows comes from here so the page makes a single request instead
 * of fanning out to five endpoints and stitching them client-side.
 */

import { z } from 'zod'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { buildPriceMap, computeCosts, type PriceEntry } from './cost-service'
import { listSurfaces } from './inbound-surface-service'

export interface SurfaceTrafficRow {
  id: string
  path: string
  client: string
  routingMode: 'routed' | 'passthrough'
  requests: number
  /** Median upstream duration in ms. Null when the surface saw no traffic. */
  p50Ms: number | null
  /** Share of requests with a non-2xx status, 0-1. Null when no traffic. */
  errorRate: number | null
}

export interface SpendRow {
  label: 'today' | 'week' | 'month' | 'savedBySubscription'
  usd: number | null
  /**
   * Change against the immediately preceding period of the same length,
   * as a ratio (0.12 = +12%). Null when either period has no priced
   * traffic, or when the previous period was zero — there is no
   * meaningful percentage change from nothing.
   */
  deltaRatio: number | null
}

export interface QuotaWindowRow {
  /** The window's own length: '5h' or '7d'. */
  window: string
  /** Model name for a per-model weekly row, null for an account-wide one. */
  scope: string | null
  pct: number
  resetAt: string | null
}

/**
 * One subscription account and every limit it is under.
 *
 * Grouped rather than a flat (account, window) list because an account
 * has several limits and any one of them hitting 100% stops it: a flat
 * list repeated the account name down the column and read as several
 * unrelated accounts. The per-model weekly rows were dropped entirely,
 * so a Claude account showed two of its three limits and no indication
 * that a third existed.
 */
export interface QuotaRow {
  subAccountId: string
  account: string
  windows: QuotaWindowRow[]
}

/**
 * One entry in the failover feed, carried as fields rather than as a
 * finished sentence.
 *
 * The server used to compose the prose here (`"<account> rate limited"`,
 * `` `reason: ${reason}` ``), which put untranslated English on the
 * landing page of a JA install and printed the scheduler's own slug at
 * the operator. `RoutingWeightChange.reason` is documented in the schema
 * as "machine slug, i18n-able on the UI side" — this is the shape that
 * lets the UI honour that.
 */
export interface FailoverRow {
  kind: 'rate_limit' | 'weight'
  tone: 'bad' | 'warn' | 'mute'
  at: string
  // rate_limit
  account: string | null
  status: number | null
  retryAfterSec: number | null
  // weight
  target: string | null
  fromWeight: number | null
  toWeight: number | null
  reason: string | null
}

/**
 * How much of a concern a weight move is.
 *
 * `ok` never reaches the feed: the scheduler emits it on every routine
 * recompute, so six of them buried the 429s that the panel exists to
 * surface. The rest are graded rather than all amber, because "the
 * window resets soon" is information and "the error rate rose" is not
 * the same news.
 */
const WEIGHT_TONE: Record<string, 'warn' | 'mute'> = {
  quota_drop: 'warn',
  error_rate: 'warn',
  stale_quota: 'warn',
  unknown_budget: 'warn',
  no_quota_kind: 'warn',
  hold_guard: 'mute',
  probe_floor: 'mute',
  reset_soon: 'mute',
  quota_recovered: 'mute'
}

export interface RecentSessionRow {
  sessionId: string
  surface: string | null
  model: string
  turns: number
  tokens: number
  costUsd: number | null
  lastAt: string
}

export interface OverviewResponse {
  windowHours: number
  generatedAt: string
  providerCount: number
  enabledModelCount: number
  surfaces: SurfaceTrafficRow[]
  spend: SpendRow[]
  quota: QuotaRow[]
  failover: FailoverRow[]
  recentSessions: RecentSessionRow[]
}

// Exact median of an already-sorted list; averages the middle pair on an
// even count so a two-request surface does not report the slower one as
// its typical latency.
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const priceKey = (provider: string, model: string): string => `${provider}||${model}`

function sumCost(
  logs: Array<{
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }>,
  priceMap: Map<string, PriceEntry>
): number | null {
  const priced = logs.map((l) => computeCosts(l, priceMap).totalCostUsd).filter((c): c is number => c !== null)
  if (priced.length === 0) return null
  return priced.reduce((a, b) => a + b, 0)
}

/**
 * Percent used for one quota window, or null when the collector has not
 * populated it. Guards against a zero limit, which upstream has been seen
 * to report while a window is being provisioned.
 */
function pct(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null
  return Math.min(100, Math.round((used / limit) * 100))
}

type WindowLog = {
  sessionId: string
  surface: string | null
  provider: string
  model: string
  durationMs: number
  status: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalInputTokens: number
  createdAt: Date
}

// The six spend periods: each tile plus the equally long period before
// it, so the delta compares like with like.
const SPEND_PERIODS = ['today', 'todayPrev', 'week', 'weekPrev', 'month', 'monthPrev'] as const

/**
 * One (provider, model) pair's token totals inside one spend period.
 *
 * Postgres folds the 60-day row set into these before it leaves the
 * database. It used to arrive here as every RequestLog row written in
 * two months — regardless of the requested window, so `?windowHours=1`
 * cost exactly as much as `?windowHours=720` — and was then walked six
 * times in JS, allocating a dayjs per row per pass. The aggregate is a
 * few dozen rows whatever the traffic.
 *
 * Aggregating first is exact rather than approximate: `computeCosts` is
 * linear in the four token counts for a fixed pair, and its null
 * (unpriced) case depends only on the pair, so summing tokens and then
 * pricing gives the same figure as pricing each row and summing.
 */
type SpendBucket = {
  label: (typeof SPEND_PERIODS)[number]
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

// Raw rows are unknown until parsed; the sums come back as double
// precision so they land as JS numbers rather than BigInt.
const SpendBucketSchema = z.object({
  label: z.enum(SPEND_PERIODS),
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number()
})

type QuotaRecord = Awaited<ReturnType<typeof loadQuotas>>[number]
type WeightChange = { target: string; fromWeight: number; toWeight: number; reason: string; createdAt: Date }

// Group by an arbitrary key while preserving first-seen order, which the
// callers rely on: `windowLogs` arrives newest-first, so the first entry
// of each bucket is that session's most recent request.
function groupBy<T>(rows: T[], key: (row: T) => string | null): { order: string[]; buckets: Map<string, T[]> } {
  const order: string[] = []
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    const bucket = buckets.get(k)
    if (bucket === undefined) {
      order.push(k)
      buckets.set(k, [row])
    } else {
      bucket.push(row)
    }
  }
  return { order, buckets }
}

function buildSurfaces(configs: ResolvedSurfaceLike[], windowLogs: WindowLog[]): SurfaceTrafficRow[] {
  const { buckets } = groupBy(windowLogs, (l) => l.surface)
  return configs.map((surface) => {
    const bucket = buckets.get(surface.id)
    const rows = bucket === undefined ? [] : bucket
    const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b)
    const errors = rows.filter((r) => r.status < 200 || r.status >= 300).length
    return {
      id: surface.id,
      path: surface.path,
      client: surface.client,
      routingMode: surface.routingMode,
      requests: rows.length,
      p50Ms: median(durations),
      errorRate: rows.length === 0 ? null : errors / rows.length
    }
  })
}

/**
 * The six period boundaries, as [from, to) instants.
 *
 * Computed once here and handed to both the SQL aggregate and nothing
 * else — the periods must not be derived twice, or a tile and its
 * delta would end up measuring windows that do not line up.
 */
function spendWindows(now: dayjs.Dayjs): Array<{ label: (typeof SPEND_PERIODS)[number]; from: Date; to: Date }> {
  const today = now.startOf('day')
  const week = now.subtract(7, 'day')
  const month = now.subtract(30, 'day')
  return [
    { label: 'today', from: today.toDate(), to: now.toDate() },
    { label: 'todayPrev', from: today.subtract(1, 'day').toDate(), to: today.toDate() },
    { label: 'week', from: week.toDate(), to: now.toDate() },
    { label: 'weekPrev', from: week.subtract(7, 'day').toDate(), to: week.toDate() },
    { label: 'month', from: month.toDate(), to: now.toDate() },
    { label: 'monthPrev', from: month.subtract(30, 'day').toDate(), to: month.toDate() }
  ]
}

// Ratio change from `previous` to `current`. A previous period of zero
// (or no priced traffic at all) has no percentage change to report — an
// "+infinity%" tile would be worse than an empty one.
function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / previous
}

function buildSpend(buckets: SpendBucket[], priceMap: Map<string, PriceEntry>): SpendRow[] {
  const byLabel = new Map<string, SpendBucket[]>()
  for (const bucket of buckets) {
    const existing = byLabel.get(bucket.label)
    if (existing === undefined) byLabel.set(bucket.label, [bucket])
    else existing.push(bucket)
  }
  // A period Postgres returned no rows for is an empty list, which
  // sumCost reports as null (nothing priced) — the same answer the
  // row-by-row version gave for a period with no traffic.
  const costOf = (label: (typeof SPEND_PERIODS)[number]): number | null => {
    const rows = byLabel.get(label)
    return sumCost(rows === undefined ? [] : rows, priceMap)
  }

  const periods: Array<{
    label: 'today' | 'week' | 'month'
    current: (typeof SPEND_PERIODS)[number]
    previous: (typeof SPEND_PERIODS)[number]
  }> = [
    { label: 'today', current: 'today', previous: 'todayPrev' },
    { label: 'week', current: 'week', previous: 'weekPrev' },
    { label: 'month', current: 'month', previous: 'monthPrev' }
  ]

  const rows: SpendRow[] = periods.map(({ label, current, previous }) => {
    const usd = costOf(current)
    return { label, usd, deltaRatio: delta(usd, costOf(previous)) }
  })

  return [
    ...rows,
    // What the subscription seats absorbed: token cost that WOULD have
    // been billed had the same traffic gone to a metered provider.
    // Computing it needs a per-request "what would this have cost on the
    // cheapest metered equivalent" mapping that does not exist yet, so it
    // reports null rather than a confident $0.
    { label: 'savedBySubscription', usd: null, deltaRatio: null }
  ]
}

const accountLabel = (q: QuotaRecord): string =>
  q.subAccount.label !== null ? q.subAccount.label : q.subAccount.provider.name

/**
 * Per-model weekly windows out of the `scopedWindows` JSONB.
 *
 * The collector writes `{ <modelSlug>: { used, limit, resetAt } }`, where
 * the slug is the model's display name lowercased. Title-cased back
 * rather than looked up in a table: a table would need extending for
 * every model Anthropic adds, and a stale one renders a blank label.
 *
 * Anything malformed is skipped rather than thrown on — one corrupt key
 * must not cost the operator the whole panel.
 */
function scopedWindows(raw: unknown): QuotaWindowRow[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: QuotaWindowRow[] = []
  for (const [slug, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue
    const rec: Record<string, unknown> = value
    const percent = pct(
      typeof rec.used === 'number' ? rec.used : null,
      typeof rec.limit === 'number' ? rec.limit : null
    )
    if (percent === null) continue
    const resetAt = typeof rec.resetAt === 'string' && rec.resetAt.length > 0 ? rec.resetAt : null
    out.push({
      window: '7d',
      scope: slug.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()),
      pct: percent,
      resetAt
    })
  }
  return out
}

function buildQuota(quotas: QuotaRecord[]): QuotaRow[] {
  const flat: Array<{
    window: string
    used: (q: QuotaRecord) => number | null
    limit: (q: QuotaRecord) => number | null
    resetAt: (q: QuotaRecord) => Date | null
  }> = [
    { window: '5h', used: (q) => q.fiveHourUsed, limit: (q) => q.fiveHourLimit, resetAt: (q) => q.fiveHourResetAt },
    { window: '7d', used: (q) => q.weeklyUsed, limit: (q) => q.weeklyLimit, resetAt: (q) => q.weeklyResetAt }
  ]
  const out: QuotaRow[] = []
  for (const q of quotas) {
    const windows: QuotaWindowRow[] = []
    // Shortest window first, then the per-model weekly rows under the 7d
    // they belong to. An order the UI can explain, rather than one that
    // implies a ranking the data does not carry.
    for (const w of flat) {
      const percent = pct(w.used(q), w.limit(q))
      if (percent === null) continue
      const resetAt = w.resetAt(q)
      windows.push({
        window: w.window,
        scope: null,
        pct: percent,
        resetAt: resetAt === null ? null : resetAt.toISOString()
      })
    }
    windows.push(...scopedWindows(q.scopedWindows))
    if (windows.length === 0) continue
    out.push({ subAccountId: q.subAccountId, account: accountLabel(q), windows })
  }
  return out
}

function buildFailover(quotas: QuotaRecord[], weightChanges: WeightChange[]): FailoverRow[] {
  const rateLimited = quotas
    .filter((q) => q.lastRateLimitedAt !== null)
    .map(
      (q): FailoverRow => ({
        kind: 'rate_limit',
        tone: 'bad',
        at: q.lastRateLimitedAt === null ? '' : q.lastRateLimitedAt.toISOString(),
        account: accountLabel(q),
        status: q.lastRateLimitStatus,
        retryAfterSec: q.lastRetryAfterSec,
        target: null,
        fromWeight: null,
        toWeight: null,
        reason: null
      })
    )

  const weights = weightChanges
    .filter((w) => w.reason !== 'ok')
    .map(
      (w): FailoverRow => ({
        kind: 'weight',
        tone: WEIGHT_TONE[w.reason] === undefined ? 'warn' : WEIGHT_TONE[w.reason],
        at: w.createdAt.toISOString(),
        account: null,
        status: null,
        retryAfterSec: null,
        target: w.target,
        fromWeight: w.fromWeight,
        toWeight: w.toWeight,
        reason: w.reason
      })
    )

  return [...rateLimited, ...weights].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)
}

function buildRecentSessions(windowLogs: WindowLog[], priceMap: Map<string, PriceEntry>): RecentSessionRow[] {
  const { order, buckets } = groupBy(windowLogs, (l) => l.sessionId)
  return order.slice(0, 8).map((sessionId) => {
    const bucket = buckets.get(sessionId)
    const rows = bucket === undefined ? [] : bucket
    const first = rows[0]
    return {
      sessionId,
      surface: first.surface,
      model: first.model,
      turns: rows.length,
      tokens: rows.reduce((sum, r) => sum + r.totalInputTokens + r.outputTokens, 0),
      costUsd: sumCost(rows, priceMap),
      lastAt: first.createdAt.toISOString()
    }
  })
}

// Narrower than ResolvedSurface so the builders stay testable without the
// DB-backed override lookup.
interface ResolvedSurfaceLike {
  id: string
  path: string
  client: string
  routingMode: 'routed' | 'passthrough'
}

function loadQuotas() {
  return getPrismaClient().subAccountQuota.findMany({
    include: { subAccount: { select: { id: true, label: true, plan: true, provider: { select: { name: true } } } } }
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
           SUM(r."cacheWriteTokens")::double precision AS "cacheWriteTokens"
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

  const [surfaceConfigs, providerCount, enabledModelCount, windowLogs, spendBuckets, quotas, weightChanges] =
    await Promise.all([
      listSurfaces(),
      prisma.provider.count(),
      prisma.model.count({ where: { enabled: true } }),
      prisma.requestLog.findMany({
        where: { createdAt: { gte: since } },
        select: {
          sessionId: true,
          surface: true,
          provider: true,
          model: true,
          durationMs: true,
          status: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          totalInputTokens: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      loadSpendBuckets(windows),
      loadQuotas(),
      prisma.routingWeightChange.findMany({ orderBy: { createdAt: 'desc' }, take: 6 })
    ])

  const priceMap = await buildPriceMap(prisma, [...new Set(spendBuckets.map((b) => priceKey(b.provider, b.model)))])

  return {
    windowHours,
    generatedAt: dayjs().toISOString(),
    providerCount,
    enabledModelCount,
    surfaces: buildSurfaces(surfaceConfigs, windowLogs),
    spend: buildSpend(spendBuckets, priceMap),
    quota: buildQuota(quotas),
    failover: buildFailover(quotas, weightChanges),
    recentSessions: buildRecentSessions(windowLogs, priceMap)
  }
}

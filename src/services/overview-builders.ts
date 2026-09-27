import type dayjs from '../lib/dayjs'
import type { AccountUsage } from './account-usage-service'
import { computeCosts, type PriceEntry } from './cost-service'
import type {
  FailoverRow,
  QuotaRow,
  QuotaWindowRow,
  RecentSessionRow,
  SpendRow,
  SurfaceTrafficRow
} from './overview-types'

export type OverviewQuotaRecord = Awaited<ReturnType<typeof import('./overview-service').loadQuotas>>[number]

// Exact median of an already-sorted list; averages the middle pair on an
// even count so a two-request surface does not report the slower one as
// its typical latency.
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function sumCost(
  logs: Array<{
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheWrite1hTokens: number
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

export type WindowLog = {
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
  cacheWrite1hTokens: number
  totalInputTokens: number
  createdAt: Date
}

// The six spend periods: each tile plus the equally long period before
// it, so the delta compares like with like.
export const SPEND_PERIODS = ['today', 'todayPrev', 'week', 'weekPrev', 'month', 'monthPrev'] as const

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
export type SpendBucket = {
  label: (typeof SPEND_PERIODS)[number]
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

export type RejectedAccount = {
  label: string
  authCheckedAt: Date | null
  authError: string | null
  provider: { name: string }
}

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

export function buildSurfaces(configs: ResolvedSurfaceLike[], windowLogs: WindowLog[]): SurfaceTrafficRow[] {
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
export function spendWindows(now: dayjs.Dayjs): Array<{ label: (typeof SPEND_PERIODS)[number]; from: Date; to: Date }> {
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

export function buildSpend(buckets: SpendBucket[], priceMap: Map<string, PriceEntry>): SpendRow[] {
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

const accountLabel = (q: OverviewQuotaRecord): string =>
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

export function buildQuota(quotas: OverviewQuotaRecord[], usage: Map<string, AccountUsage>): QuotaRow[] {
  const flat: Array<{
    window: string
    used: (q: OverviewQuotaRecord) => number | null
    limit: (q: OverviewQuotaRecord) => number | null
    resetAt: (q: OverviewQuotaRecord) => Date | null
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
    const carried = usage.get(q.subAccountId)
    out.push({
      subAccountId: q.subAccountId,
      account: accountLabel(q),
      windows,
      usage: carried === undefined ? null : carried,
      resetCredits:
        q.resetCreditsAvailable === null
          ? null
          : { available: q.resetCreditsAvailable, applicable: q.resetCreditsApplicable }
    })
  }
  return out
}

export function buildFailover(quotas: OverviewQuotaRecord[], rejected: RejectedAccount[]): FailoverRow[] {
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
        error: null
      })
    )

  const unauthenticated = rejected.map(
    (a): FailoverRow => ({
      kind: 'auth',
      tone: 'bad',
      at: a.authCheckedAt === null ? '' : a.authCheckedAt.toISOString(),
      account: a.label !== '' ? a.label : a.provider.name,
      status: null,
      retryAfterSec: null,
      error: a.authError
    })
  )

  return [...rateLimited, ...unauthenticated].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)
}

export function buildRecentSessions(windowLogs: WindowLog[], priceMap: Map<string, PriceEntry>): RecentSessionRow[] {
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
export interface ResolvedSurfaceLike {
  id: string
  path: string
  client: string
  routingMode: 'routed' | 'passthrough'
}

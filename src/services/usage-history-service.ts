import { planCapacityWeight } from '@/shared/plan-capacity'
import { windowProjectedPct } from '@/shared/quota-pace'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'
import type { ClaudeUsage, CodexUsage } from '../schemas/api/usage'
import { refreshQuotaSnapshots } from './routing-scheduler/collector'
import { recordPerAccountUsage, scopedMetricKey } from './subaccount-usage-store'
import { fetchUsageSnapshotWithAccountIds } from './usage-service'

// The chart offers 30 days; keep the edge beyond its longest range.
const RETAIN_DAYS = 31
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 6 * 60 * 1000

interface SnapshotRow {
  provider: string
  metric: string
  percent: number
  resetAt: Date | null
  subAccountId: string
  planWeight: number
  projectedPct: number | null
  capturedAt: Date
}

type AccountMeta = { kind: 'claude' | 'codex'; plan: string | null; rateLimitTier: string | null }

const toDate = (iso: string | null): Date | null => {
  if (!iso) return null
  const d = dayjs(iso)
  return d.isValid() ? d.toDate() : null
}

const accountRows = (
  subAccountId: string,
  provider: 'claude' | 'codex',
  capturedAt: string,
  windows: readonly { metric: string; percent: number; resetAt: string | null; durationMs: number | null }[],
  meta: AccountMeta | undefined,
  now: number
): SnapshotRow[] => {
  const captured = dayjs(capturedAt)
  // A cached response from a failed poll must not become a new reading.
  if (!captured.isValid() || Math.abs(now - captured.valueOf()) > STALE_MS) return []
  const weight = meta === undefined ? 1 : planCapacityWeight(meta.kind, meta.plan, meta.rateLimitTier)
  return windows.map((w) => {
    const resetAt = toDate(w.resetAt)
    return {
      provider,
      metric: w.metric,
      percent: w.percent,
      resetAt,
      subAccountId,
      planWeight: weight,
      // An idle window has no running reset clock, not missing usage.
      projectedPct:
        w.percent === 0 && resetAt === null
          ? 0
          : windowProjectedPct(
              w.percent,
              resetAt === null ? null : resetAt.valueOf(),
              w.durationMs,
              captured.valueOf()
            ),
      capturedAt: dayjs(now).floor('minute', 5).toDate()
    }
  })
}

export const claudeHistoryRows = (u: ClaudeUsage, meta: AccountMeta | undefined, now: number): SnapshotRow[] => {
  const windows: { metric: string; percent: number; resetAt: string | null; durationMs: number }[] = []
  const add = (metric: string, value: { utilization: number; resetsAt: string | null } | null, durationMs: number) => {
    if (value !== null) windows.push({ metric, percent: value.utilization, resetAt: value.resetsAt, durationMs })
  }
  add('claude.five_hour', u.fiveHour, FIVE_HOURS_MS)
  add('claude.seven_day', u.sevenDay, WEEK_MS)
  add('claude.seven_day_sonnet', u.sevenDaySonnet, WEEK_MS)
  add('claude.seven_day_opus', u.sevenDayOpus, WEEK_MS)
  for (const scoped of u.weeklyScoped) {
    windows.push({
      metric: scopedMetricKey(scoped.modelName),
      percent: scoped.utilization,
      resetAt: scoped.resetsAt,
      durationMs: WEEK_MS
    })
  }
  return accountRows(u.subAccountId, 'claude', u.capturedAt, windows, meta, now)
}

export const codexHistoryRows = (u: CodexUsage, meta: AccountMeta | undefined, now: number): SnapshotRow[] => {
  const windows: { metric: string; percent: number; resetAt: string | null; durationMs: number | null }[] = []
  if (u.primary !== null) {
    windows.push({
      metric: 'codex.primary',
      percent: u.primary.usedPercent,
      resetAt: u.primary.resetAt,
      durationMs: u.primary.windowSeconds === null ? null : u.primary.windowSeconds * 1000
    })
  }
  if (u.secondary !== null) {
    windows.push({
      metric: 'codex.secondary',
      percent: u.secondary.usedPercent,
      resetAt: u.secondary.resetAt,
      durationMs: u.secondary.windowSeconds === null ? null : u.secondary.windowSeconds * 1000
    })
  }
  return accountRows(u.subAccountId, 'codex', u.capturedAt, windows, meta, now)
}

export async function recordUsageSnapshots(): Promise<void> {
  const paired = await fetchUsageSnapshotWithAccountIds()
  const usage = { claude: paired.claude.map((p) => p.usage), codex: paired.codex.map((p) => p.usage) }
  const now = dayjs().valueOf()
  const ids = [...usage.claude, ...usage.codex].map((u) => u.subAccountId)
  const accounts = await getPrismaClient().subAccount.findMany({
    where: { id: { in: ids } },
    select: { id: true, plan: true, rateLimitTier: true }
  })
  const meta = new Map(accounts.map((a) => [a.id, a]))
  const rows = [
    ...usage.claude.flatMap((u) => {
      const account = meta.get(u.subAccountId)
      return claudeHistoryRows(
        u,
        account === undefined
          ? undefined
          : { kind: 'claude', plan: account.plan, rateLimitTier: account.rateLimitTier },
        now
      )
    }),
    ...usage.codex.flatMap((u) => {
      const account = meta.get(u.subAccountId)
      if (account === undefined) return codexHistoryRows(u, undefined, now)
      return codexHistoryRows(
        u,
        { kind: 'codex', plan: u.planType === null ? account.plan : u.planType, rateLimitTier: account.rateLimitTier },
        now
      )
    })
  ]
  if (rows.length > 0) await getPrismaClient().usageSnapshot.createMany({ data: rows })
  await recordPerAccountUsage(paired.claude, paired.codex)
  const outcome = await refreshQuotaSnapshots({ claude: paired.claude, codex: paired.codex })
  if (outcome.failed > 0) logger.warn(outcome, '[routing-scheduler] SubAccountQuota refresh had per-account failures')
}

export async function pruneOldSnapshots(): Promise<void> {
  await getPrismaClient().usageSnapshot.deleteMany({
    where: { capturedAt: { lt: dayjs().subtract(RETAIN_DAYS, 'day').toDate() } }
  })
}

export interface UsageSample {
  metric: string
  projectedPct: number | null
  t: string
}

export interface UsageHistory {
  samples: UsageSample[]
}

interface HistoryRow {
  metric: string
  capturedAt: Date
  subAccountId: string | null
  planWeight: number | null
  projectedPct: number | null
}

// Do not merge old aggregate rows with account samples or count an
// unknown forecast as idle. Each point names one window and poll time.
export function aggregatePaceHistory(rows: readonly HistoryRow[]): UsageSample[] {
  const grouped = new Map<string, { metric: string; t: string; sum: number; weight: number; accounts: Set<string> }>()
  for (const row of rows) {
    const t = dayjs(row.capturedAt).toISOString()
    const key = `${t}:${row.metric}`
    const previous = grouped.get(key)
    const bucket =
      previous === undefined ? { metric: row.metric, t, sum: 0, weight: 0, accounts: new Set<string>() } : previous
    if (
      row.subAccountId !== null &&
      row.projectedPct !== null &&
      Number.isFinite(row.projectedPct) &&
      !bucket.accounts.has(row.subAccountId)
    ) {
      const weight = row.planWeight !== null && row.planWeight > 0 ? row.planWeight : 1
      bucket.sum += row.projectedPct * weight
      bucket.weight += weight
      bucket.accounts.add(row.subAccountId)
    }
    grouped.set(key, bucket)
  }
  return [...grouped.values()].map((b) => ({
    metric: b.metric,
    t: b.t,
    projectedPct: b.weight === 0 ? null : Math.round((b.sum / b.weight) * 10) / 10
  }))
}

export async function getUsageHistory(days: number): Promise<UsageHistory> {
  const rows = await getPrismaClient().usageSnapshot.findMany({
    where: { capturedAt: { gte: dayjs().subtract(days, 'day').toDate() }, metric: { not: { contains: ':' } } },
    orderBy: { capturedAt: 'asc' },
    select: { metric: true, capturedAt: true, subAccountId: true, planWeight: true, projectedPct: true }
  })
  return { samples: aggregatePaceHistory(rows) }
}

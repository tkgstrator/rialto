/**
 * Per-account rate-limit window state, persisted to the DB.
 *
 * Distinct from `usage-history-service`:
 *   - `UsageSnapshot` (history) — time-series, averaged across accounts,
 *     drives the chart in the Usage view.
 *   - `SubAccountUsage` (this file) — latest state per (subAccountId,
 *     metric), no history. The router consults this to make 429-avoidance
 *     decisions: skip an account whose `percent >= 100` while `resetAt`
 *     is still in the future.
 *
 * The poller (`usage-job` → `usage-history-service.recordUsageSnapshots`)
 * also calls `recordPerAccountUsage()` so both tables refresh on the same
 * 5-min cadence.
 */

import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import type { ClaudeUsage, CodexUsage } from '../schemas/api/usage'
// Window keys mirror the strings UsageSnapshot uses so the two tables
// stay aligned at the metric layer.
export const CLAUDE_METRICS = {
  five_hour: 'claude.five_hour',
  seven_day: 'claude.seven_day',
  seven_day_sonnet: 'claude.seven_day_sonnet',
  seven_day_opus: 'claude.seven_day_opus'
} as const

// Per-model scoped 7-day windows come back with a display_name (e.g.
// "Fable"). The metric key uses a lowercased slug of that name so a new
// model surfacing on the API is stored / charted without a code change.
const SCOPED_METRIC_PREFIX = 'claude.seven_day_scoped.' as const
type ScopedMetric = `${typeof SCOPED_METRIC_PREFIX}${string}`
export const scopedMetricKey = (modelName: string): ScopedMetric =>
  `${SCOPED_METRIC_PREFIX}${modelName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
export const isScopedMetric = (metric: string): boolean => metric.startsWith(SCOPED_METRIC_PREFIX)

// Inverse of scopedMetricKey: the model slug a scoped window is about,
// or null when the metric is not per-model. The account picker needs it
// to decide whether a window binds for the model actually being
// requested — Fable's weekly allowance says nothing about a Sonnet call.
export const scopedMetricModel = (metric: string): string | null =>
  metric.startsWith(SCOPED_METRIC_PREFIX) ? metric.slice(SCOPED_METRIC_PREFIX.length) : null

export const CODEX_METRICS = {
  primary: 'codex.primary',
  secondary: 'codex.secondary'
} as const

export type ClaudeMetric = (typeof CLAUDE_METRICS)[keyof typeof CLAUDE_METRICS]
export type CodexMetric = (typeof CODEX_METRICS)[keyof typeof CODEX_METRICS]
// Scoped-model metric keys (e.g. `claude.seven_day_scoped.fable`) are
// generated at runtime from the API's `display_name`, so the wider
// `Metric` union has to admit any string that starts with the scoped
// prefix in addition to the fixed enums.
export type Metric = ClaudeMetric | CodexMetric | ScopedMetric

const toDate = (iso: string | null): Date | null => {
  if (!iso) return null
  const d = dayjs(iso)
  return d.isValid() ? d.toDate() : null
}

interface PerAccountRow {
  subAccountId: string
  metric: Metric
  percent: number
  resetAt: Date | null
}

const claudeRowsFor = (subAccountId: string, u: ClaudeUsage): PerAccountRow[] => {
  const rows: PerAccountRow[] = []
  if (u.fiveHour) {
    rows.push({
      subAccountId,
      metric: CLAUDE_METRICS.five_hour,
      percent: u.fiveHour.utilization,
      resetAt: toDate(u.fiveHour.resetsAt)
    })
  }
  if (u.sevenDay) {
    rows.push({
      subAccountId,
      metric: CLAUDE_METRICS.seven_day,
      percent: u.sevenDay.utilization,
      resetAt: toDate(u.sevenDay.resetsAt)
    })
  }
  if (u.sevenDaySonnet) {
    rows.push({
      subAccountId,
      metric: CLAUDE_METRICS.seven_day_sonnet,
      percent: u.sevenDaySonnet.utilization,
      resetAt: toDate(u.sevenDaySonnet.resetsAt)
    })
  }
  if (u.sevenDayOpus) {
    rows.push({
      subAccountId,
      metric: CLAUDE_METRICS.seven_day_opus,
      percent: u.sevenDayOpus.utilization,
      resetAt: toDate(u.sevenDayOpus.resetsAt)
    })
  }
  for (const scoped of u.weeklyScoped) {
    rows.push({
      subAccountId,
      metric: scopedMetricKey(scoped.modelName),
      percent: scoped.utilization,
      resetAt: toDate(scoped.resetsAt)
    })
  }
  return rows
}

const codexRowsFor = (subAccountId: string, u: CodexUsage): PerAccountRow[] => {
  const rows: PerAccountRow[] = []
  if (u.primary) {
    rows.push({
      subAccountId,
      metric: CODEX_METRICS.primary,
      percent: u.primary.usedPercent,
      resetAt: toDate(u.primary.resetAt)
    })
  }
  if (u.secondary) {
    rows.push({
      subAccountId,
      metric: CODEX_METRICS.secondary,
      percent: u.secondary.usedPercent,
      resetAt: toDate(u.secondary.resetAt)
    })
  }
  return rows
}

// Upsert one usage row keyed by (subAccountId, metric). Splitting upserts
// into individual writes (rather than one createMany) is necessary
// because Prisma can't express a multi-column on-conflict in createMany.
const upsertRow = async (prisma: PrismaClient, row: PerAccountRow): Promise<void> => {
  await prisma.subAccountUsage.upsert({
    where: { subAccountId_metric: { subAccountId: row.subAccountId, metric: row.metric } },
    create: row,
    update: { percent: row.percent, resetAt: row.resetAt }
  })
}

// Write per-account window state for a batch of usage snapshots.
// `accountsClaude` and `accountsCodex` carry the same Claude/Codex
// snapshots the existing poller already fetched (no extra network calls).
// The mapping subAccountId → label is preserved via the snapshot's
// `accountLabel`; this function expects the caller to pass the matching
// subAccountId alongside each snapshot.
export async function recordPerAccountUsage(
  claude: Array<{ subAccountId: string; usage: ClaudeUsage }>,
  codex: Array<{ subAccountId: string; usage: CodexUsage }>,
  prisma: PrismaClient = getPrismaClient()
): Promise<void> {
  const rows: PerAccountRow[] = []
  for (const { subAccountId, usage } of claude) rows.push(...claudeRowsFor(subAccountId, usage))
  for (const { subAccountId, usage } of codex) rows.push(...codexRowsFor(subAccountId, usage))
  for (const row of rows) await upsertRow(prisma, row)
}

// Per-account usage map keyed by metric — the shape the router reads on
// each routing decision. Missing entries (no row in the table yet) are
// modelled as `null` so callers can branch on "no data" the same way
// the in-memory cache layer already does.
export type AccountUsageMap = Map<Metric, { percent: number; resetAt: Date | null }>

// Batch read the per-account usage for a set of accounts. Returns a
// Map<subAccountId, AccountUsageMap>; accounts with no rows show up as
// empty inner maps (NOT missing) so callers don't have to null-check the
// outer map.
export async function getPerAccountUsage(
  subAccountIds: string[],
  prisma: PrismaClient = getPrismaClient()
): Promise<Map<string, AccountUsageMap>> {
  const out = new Map<string, AccountUsageMap>(subAccountIds.map((id) => [id, new Map()]))
  if (subAccountIds.length === 0) return out
  const rows = await prisma.subAccountUsage.findMany({
    where: { subAccountId: { in: subAccountIds } },
    select: { subAccountId: true, metric: true, percent: true, resetAt: true }
  })
  for (const r of rows) {
    const inner = out.get(r.subAccountId)
    if (inner) inner.set(r.metric as Metric, { percent: r.percent, resetAt: r.resetAt })
  }
  return out
}

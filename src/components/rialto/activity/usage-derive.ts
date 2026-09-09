/**
 * Pure shaping behind Activity › Usage.
 *
 * The screen has three panels reading three endpoints, and each one needs
 * the wire shape turned into something a table or a chart can consume.
 * None of that needs React, and all of it is the part that can be wrong in
 * a way nobody notices — a mislabelled series, a share column that sums to
 * 140% — so it lives here where a test can hold it.
 */

import type { AccessTokenWire } from '@/lib/api'
import dayjs from '@/lib/dayjs'

// ---- Subscription windows -------------------------------------------

/** One utilization window as the windows panel renders it. */
export interface WindowRow {
  /** Window kind: `5-hour`, `7-day`, `primary`, … Already translated. */
  label: string
  /** Model this window is scoped to, when it is. Rendered as a mono tag. */
  scope: string | null
  pct: number
  resetsAt: string | null
}

export interface AccountWindows {
  subAccountId: string
  account: string
  /** Plan / vendor line beside the account name. Null when unknown. */
  plan: string | null
  windows: WindowRow[]
}

/** `/api/usage` as the browser consumes it. Mirrors schemas/api/usage.ts. */
export interface UsageWindowValue {
  utilization: number
  resetsAt: string | null
}

export interface UsageScopedWindow {
  modelName: string
  utilization: number
  resetsAt: string | null
}

export interface ClaudeUsageWire {
  subAccountId: string
  accountLabel: string
  fiveHour: UsageWindowValue | null
  sevenDay: UsageWindowValue | null
  sevenDaySonnet: UsageWindowValue | null
  sevenDayOpus: UsageWindowValue | null
  weeklyScoped: UsageScopedWindow[]
  extraUsageEnabled: boolean
  capturedAt: string
}

export interface CodexUsageWire {
  subAccountId: string
  accountLabel: string
  planType: string | null
  primary: { usedPercent: number; resetAt: string | null; windowSeconds: number | null } | null
  secondary: { usedPercent: number; resetAt: string | null; windowSeconds: number | null } | null
  capturedAt: string
}

export interface UsageWire {
  claude: ClaudeUsageWire[]
  codex: CodexUsageWire[]
}

/** Translation keys the window labels resolve through. */
export const WINDOW_LABEL_KEYS = {
  fiveHour: 'activity.usage.windowFiveHour',
  sevenDay: 'activity.usage.windowSevenDay',
  sevenDayScoped: 'activity.usage.windowSevenDayScoped',
  primary: 'activity.usage.windowPrimary',
  secondary: 'activity.usage.windowSecondary'
} as const

type Translate = (key: string) => string

/**
 * One Claude account's windows, account-wide first then per-model.
 *
 * The scoped weekly windows are the reason this panel exists: Overview's
 * `quota` array carries only the flat 5h/7d pair, so a per-model limit
 * (the one that actually stops a Fable request) is currently visible
 * nowhere. They come after the account-wide ones because an operator
 * scanning for "am I near the wall" reads the broader limit first.
 *
 * `sevenDaySonnet` / `sevenDayOpus` are the pre-`limits[]` spelling of the
 * same thing. Anthropic stopped populating them for most plans, so they
 * are emitted only when present and are never synthesised from the scoped
 * list — showing one window twice under two names is worse than once.
 */
const claudeWindows = (account: ClaudeUsageWire, t: Translate): WindowRow[] => {
  const windows: WindowRow[] = []
  const flat: [UsageWindowValue | null, string][] = [
    [account.fiveHour, t(WINDOW_LABEL_KEYS.fiveHour)],
    [account.sevenDay, t(WINDOW_LABEL_KEYS.sevenDay)]
  ]
  for (const [value, label] of flat) {
    if (value !== null) windows.push({ label, scope: null, pct: value.utilization, resetsAt: value.resetsAt })
  }
  const scopedLabel = t(WINDOW_LABEL_KEYS.sevenDayScoped)
  const legacyScoped: [UsageWindowValue | null, string][] = [
    [account.sevenDaySonnet, 'Sonnet'],
    [account.sevenDayOpus, 'Opus']
  ]
  for (const [value, scope] of legacyScoped) {
    if (value !== null) {
      windows.push({ label: scopedLabel, scope, pct: value.utilization, resetsAt: value.resetsAt })
    }
  }
  for (const scoped of account.weeklyScoped) {
    windows.push({
      label: scopedLabel,
      scope: scoped.modelName,
      pct: scoped.utilization,
      resetsAt: scoped.resetsAt
    })
  }
  return windows
}

const codexWindows = (account: CodexUsageWire, t: Translate): WindowRow[] => {
  const flat: [CodexUsageWire['primary'], string][] = [
    [account.primary, t(WINDOW_LABEL_KEYS.primary)],
    [account.secondary, t(WINDOW_LABEL_KEYS.secondary)]
  ]
  const windows: WindowRow[] = []
  for (const [value, label] of flat) {
    if (value !== null) windows.push({ label, scope: null, pct: value.usedPercent, resetsAt: value.resetAt })
  }
  return windows
}

/** Flatten `/api/usage` into per-account window lists, Claude then Codex. */
export function accountWindows(usage: UsageWire, t: Translate): AccountWindows[] {
  return [
    ...usage.claude.map((account) => ({
      subAccountId: account.subAccountId,
      account: account.accountLabel,
      plan: null,
      windows: claudeWindows(account, t)
    })),
    ...usage.codex.map((account) => ({
      subAccountId: account.subAccountId,
      account: account.accountLabel,
      plan: account.planType,
      windows: codexWindows(account, t)
    }))
  ]
}

// ---- Utilization over time ------------------------------------------

export interface UsageHistorySample {
  metric: string
  percent: number
  t: string
  resetAt: string | null
}

/** One plotted point: a bucket timestamp plus a percent per metric. */
export interface ChartPoint {
  t: number
  [metric: string]: number | null
}

export interface UsageSeries {
  metric: string
  label: string
}

/**
 * Human label for a collector metric key.
 *
 * The keys are the collector's, not the UI's: `claude.five_hour`,
 * `codex.primary`, and `claude.seven_day_scoped.<slug>` for the per-model
 * weekly windows. The scoped slug is the model name lowercased, so it is
 * title-cased back rather than looked up — a table would have to be
 * extended for every model Anthropic adds, and a stale table renders a
 * blank legend entry.
 */
export function metricLabel(metric: string, t: Translate): string {
  if (metric === 'claude.five_hour') return t(WINDOW_LABEL_KEYS.fiveHour)
  if (metric === 'claude.seven_day') return t(WINDOW_LABEL_KEYS.sevenDay)
  if (metric === 'codex.primary') return t(WINDOW_LABEL_KEYS.primary)
  if (metric === 'codex.secondary') return t(WINDOW_LABEL_KEYS.secondary)
  const scopedPrefix = 'claude.seven_day_scoped.'
  if (metric.startsWith(scopedPrefix)) {
    const slug = metric.slice(scopedPrefix.length)
    const name = slug.length === 0 ? slug : `${slug[0].toUpperCase()}${slug.slice(1)}`
    return `${t(WINDOW_LABEL_KEYS.sevenDay)} · ${name}`
  }
  return metric
}

/**
 * Bucket the raw samples into at most `buckets` points, keeping the MAX
 * per bucket.
 *
 * The collector samples every 5 minutes, so a 7-day window is ~2000
 * points — more than the pixels available and more than recharts should
 * be asked to lay out. Max rather than mean because the question this
 * chart answers is "how close to the wall did this window get": a
 * five-hour window that touched 95% and fell back matters, and an average
 * erases exactly that spike.
 *
 * A bucket with no sample for a metric emits null, which recharts draws
 * as a gap. That is the honest rendering of a collector outage — joining
 * across it would invent a straight line through hours nobody measured.
 */
// Bucket index -> metric -> highest percent seen in that bucket. Split
// out of `bucketSamples` so the collection and the assembly are each
// small enough to read (and to stay under the complexity budget).
const collectPeaks = (
  samples: readonly UsageHistorySample[],
  span: { start: number; width: number; span: number; buckets: number }
): Map<number, Map<string, number>> => {
  const peaks = new Map<number, Map<string, number>>()
  for (const sample of samples) {
    const at = Date.parse(sample.t)
    if (Number.isNaN(at)) continue
    const index = span.span <= 0 ? 0 : Math.min(span.buckets - 1, Math.floor((at - span.start) / span.width))
    const bucket = peaks.get(index)
    if (bucket === undefined) {
      peaks.set(index, new Map([[sample.metric, sample.percent]]))
      continue
    }
    const current = bucket.get(sample.metric)
    if (current === undefined || sample.percent > current) bucket.set(sample.metric, sample.percent)
  }
  return peaks
}

export function bucketSamples(samples: readonly UsageHistorySample[], buckets: number): ChartPoint[] {
  if (samples.length === 0 || buckets <= 0) return []
  const times = samples.map((s) => Date.parse(s.t)).filter((n) => !Number.isNaN(n))
  if (times.length === 0) return []
  const start = Math.min(...times)
  const end = Math.max(...times)
  const metrics = [...new Set(samples.map((s) => s.metric))]
  // A single instant (or a window shorter than one bucket) collapses to
  // one point rather than dividing by zero.
  const span = end - start
  const width = span <= 0 ? 1 : span / buckets
  const peaks = collectPeaks(samples, { start, width, span, buckets })
  const points: ChartPoint[] = []
  for (const index of [...peaks.keys()].sort((a, b) => a - b)) {
    const bucket = peaks.get(index)
    if (bucket === undefined) continue
    const point: ChartPoint = { t: Math.round(start + index * width) }
    for (const metric of metrics) {
      const value = bucket.get(metric)
      point[metric] = value === undefined ? null : value
    }
    points.push(point)
  }
  return points
}

/** Series present in the window, ordered so the legend is stable. */
export function seriesOf(samples: readonly UsageHistorySample[], t: Translate): UsageSeries[] {
  return [...new Set(samples.map((s) => s.metric))]
    .sort((a, b) => a.localeCompare(b))
    .map((metric) => ({ metric, label: metricLabel(metric, t) }))
}

/**
 * The plotted points as CSV rows: an ISO timestamp column plus one column
 * per series, in the order the legend shows them.
 *
 * Exports what is on screen — the bucketed peaks, not the raw 5-minute
 * samples. Handing back a different dataset than the one the operator is
 * looking at is how a spreadsheet ends up disagreeing with the chart it
 * was taken from. An unmeasured bucket exports as an empty cell rather
 * than a zero, for the same reason the line breaks there.
 */
export function chartCsvRows(points: readonly ChartPoint[], series: readonly UsageSeries[]): string[][] {
  const header = ['time', ...series.map((s) => s.label)]
  const rows = points.map((point) => [
    dayjs(point.t).toISOString(),
    ...series.map((s) => {
      const value = point[s.metric]
      return typeof value === 'number' ? String(value) : ''
    })
  ])
  return [header, ...rows]
}

// ---- Per-token spend -------------------------------------------------

export interface TokenUsageRow {
  id: string
  name: string
  prefix: string
  surfaces: string[]
  requestCount: number
  costUsd: number | null
  /** Share of the priced total, 0-100. Null when nothing priced. */
  sharePct: number | null
  lastUsedAt: string | null
}

/**
 * Token rows ordered by spend, with each one's share of the priced total.
 *
 * The share denominator is the sum of the tokens that HAVE a price, not
 * of every token: subscription traffic prices to null, and folding those
 * in as zero would quietly report a share of a total that does not exist.
 * A token with no priced traffic gets a null share and renders as a dash,
 * the same answer its cost cell gives.
 *
 * Revoked tokens are kept. Their traffic is part of what the window cost,
 * and dropping them makes the shares of the survivors add up to more than
 * the money actually spent.
 */
export function tokenUsageRows(tokens: readonly AccessTokenWire[]): TokenUsageRow[] {
  const total = tokens.reduce((sum, token) => (token.costUsd === null ? sum : sum + token.costUsd), 0)
  return tokens
    .map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      surfaces: token.surfaces,
      requestCount: token.requestCount,
      costUsd: token.costUsd,
      sharePct: token.costUsd === null || total <= 0 ? null : Math.round((token.costUsd / total) * 100),
      lastUsedAt: token.lastUsedAt
    }))
    .sort((a, b) => {
      // Unpriced tokens sort last rather than as $0 — they are unknown,
      // not free, and parking them mid-table reads as "cheaper than".
      if (a.costUsd === null && b.costUsd === null) return b.requestCount - a.requestCount
      if (a.costUsd === null) return 1
      if (b.costUsd === null) return -1
      return b.costUsd - a.costUsd
    })
}

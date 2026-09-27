import { WINDOW_LABEL_KEYS } from '@/components/rialto/activity/usage-windows'

type Translate = (key: string) => string

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

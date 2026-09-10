/**
 * The Requests row model and everything that narrows it.
 *
 * Split from the screen because the filter bar and the table pull in
 * opposite directions: the table cares what a row looks like, the filter
 * bar only what a row *is*. Keeping the range/status vocabulary next to
 * `applyFilters` — rather than next to the controls that display it —
 * means a new range is one edit, and the screen never learns how a
 * cutoff is computed.
 */
import type { ActivityRequestLog } from '@/components/rialto/activity/data'
import type { FilterOption } from '@/components/rialto/activity/shared'

export type RangeId = '1h' | '6h' | '24h' | '7d' | 'all'

/**
 * `hours` is sent to the server, which owns the cutoff — 0 means the
 * whole archive. It used to be applied in the browser against the rows
 * already fetched, which made a range a filter over one page rather than
 * a window over the archive.
 */
export const RANGES: readonly { id: RangeId; labelKey: string; hours: number }[] = [
  { id: '1h', labelKey: 'activity.requests.range1h', hours: 1 },
  { id: '6h', labelKey: 'activity.requests.range6h', hours: 6 },
  { id: '24h', labelKey: 'activity.requests.range24h', hours: 24 },
  { id: '7d', labelKey: 'activity.requests.range7d', hours: 168 },
  { id: 'all', labelKey: 'activity.requests.rangeAll', hours: 0 }
]

/** Hours for a range id, for the fetch. Unknown ids read as "all". */
export const rangeHours = (id: RangeId): number => {
  const spec = RANGES.find((r) => r.id === id)
  return spec === undefined ? 0 : spec.hours
}

export type StatusId = 'all' | 'ok' | 'rate-limited' | 'failed'

/**
 * The status filter. Only the "all" entry is prose; the other three are
 * HTTP status classes, which read the same in every language.
 */
export const statusOptions = (allLabel: string): FilterOption<StatusId>[] => [
  { id: 'all', label: allLabel },
  { id: 'ok', label: '2xx' },
  { id: 'rate-limited', label: '429' },
  { id: 'failed', label: '4xx / 5xx' }
]

/** Routing lane, as an id: the label for it is looked up on render. */
export type LaneId = 'untracked' | 'subagent' | 'agent'

export interface Row {
  log: ActivityRequestLog
  surfacePath: string | null
  /** Nearest thing the data has to a caller identity — see the report. */
  client: string | null
  lane: LaneId
  rule: string | null
}

export const lane = (isSubagent: boolean | null): LaneId => {
  if (isSubagent === null) return 'untracked'
  return isSubagent ? 'subagent' : 'agent'
}

export const LANE_KEYS: Record<LaneId, string> = {
  untracked: 'activity.requests.laneUntracked',
  subagent: 'activity.requests.laneSubagent',
  agent: 'activity.requests.laneAgent'
}

const statusMatches = (status: number, filter: StatusId): boolean => {
  if (filter === 'all') return true
  if (filter === 'ok') return status >= 200 && status < 300
  if (filter === 'rate-limited') return status === 429
  return status >= 400 && status !== 429
}

export interface Filters {
  surface: string
  status: StatusId
  client: string
  rule: string
  range: RangeId
}

/**
 * Narrow the fetched page.
 *
 * The range is deliberately absent: the server already returned only the
 * window, and re-applying a cutoff computed from a browser clock that
 * keeps ticking would drop rows near the boundary that the page was
 * quoted as containing.
 */
export function applyFilters(rows: Row[], filters: Filters): Row[] {
  return rows.filter((row) => {
    if (filters.surface !== 'all' && row.surfacePath !== filters.surface) return false
    if (!statusMatches(row.log.status, filters.status)) return false
    if (filters.client !== 'all' && row.client !== filters.client) return false
    if (filters.rule !== 'all' && row.rule !== filters.rule) return false
    return true
  })
}

export const options = (values: (string | null)[], allLabel: string): FilterOption<string>[] => [
  { id: 'all', label: allLabel },
  ...[...new Set(values.filter((v): v is string => v !== null))].sort().map((v) => ({ id: v, label: v }))
]

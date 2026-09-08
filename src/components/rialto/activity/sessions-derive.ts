/**
 * Pure derivations behind Activity › Sessions.
 *
 * The screen composes these; none of them touches React or the network.
 * The seam is the `Enriched` row: everything above it turns two
 * independent fetches (the session aggregate and a page of raw calls)
 * into one row model, everything below narrows a list of those rows.
 * Keeping both halves here rather than in the screen is what makes the
 * range table the single answer to "how far back does 7d go" — the
 * sessions endpoint counts in hours and the cost endpoint in days, and
 * that mismatch is easier to get wrong than to read.
 */
import type { FilterOption } from '@/components/rialto/activity/shared'
import type { SessionSummary } from '@/lib/api'

export type RangeId = '24h' | '7d' | '30d' | 'all'

export interface RangeSpec {
  id: RangeId
  /** Translation key for the range label; the screen resolves it. */
  labelKey: string
  /** For /api/request-logs/sessions, which counts back in hours. 0 = no limit. */
  hours: number
  /** For /api/usage/cost, which counts back in days. 0 = no limit. */
  days: number
}

export const RANGES: readonly RangeSpec[] = [
  { id: '24h', labelKey: 'activity.sessions.range24h', hours: 24, days: 1 },
  { id: '7d', labelKey: 'activity.sessions.range7d', hours: 168, days: 7 },
  { id: '30d', labelKey: 'activity.sessions.range30d', hours: 720, days: 30 },
  { id: 'all', labelKey: 'activity.sessions.rangeAll', hours: 0, days: 0 }
]

export const rangeSpec = (id: RangeId): RangeSpec => {
  const found = RANGES.find((r) => r.id === id)
  return found === undefined ? RANGES[1] : found
}

export const ALL = 'all'

export interface Enriched {
  session: SessionSummary
  surfacePath: string | null
  model: string | null
}

export function enrich(sessions: SessionSummary[], pathOf: (id: string | null) => string | null): Enriched[] {
  return sessions.map((session) => ({
    session,
    surfacePath: pathOf(session.surface),
    model: session.models.length === 0 ? null : session.models[0]
  }))
}

function matchesQuery(row: Enriched, query: string): boolean {
  if (query === '') return true
  const preview = row.session.preview
  const haystack = preview === null ? row.session.sessionId : `${row.session.sessionId} ${preview}`
  return haystack.toLowerCase().includes(query.toLowerCase())
}

export function applyFilters(
  rows: Enriched[],
  filters: { surface: string; provider: string; model: string; query: string }
): Enriched[] {
  return rows.filter((row) => {
    if (filters.surface !== ALL && row.surfacePath !== filters.surface) return false
    if (filters.provider !== ALL && !row.session.providers.includes(filters.provider)) return false
    if (filters.model !== ALL && !row.session.models.includes(filters.model)) return false
    return matchesQuery(row, filters.query)
  })
}

export function options(values: string[], allLabel: string): FilterOption<string>[] {
  return [{ id: ALL, label: allLabel }, ...[...new Set(values)].sort().map((v) => ({ id: v, label: v }))]
}

export function parseSessionId(data: string): string | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed !== null && typeof parsed === 'object') {
      const id = Reflect.get(parsed, 'sessionId')
      if (typeof id === 'string') return id
    }
  } catch {
    // A malformed frame is not worth a console line.
  }
  return null
}

export function upsertSession(prev: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const idx = prev.findIndex((s) => s.sessionId === next.sessionId)
  if (idx === -1) return [next, ...prev]
  return prev.map((s, i) => (i === idx ? next : s))
}

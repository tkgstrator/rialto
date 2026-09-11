/**
 * Wire types and pure helpers behind the four Activity screens.
 *
 * `RequestLogItem` in lib/api.ts carries `surface`; it does not yet carry
 * `isSubagent`, which the list handler already spreads onto the response
 * from the Prisma row. That one field is declared here rather than added
 * to lib/api.ts, which the Rialto migration keeps frozen.
 */
import type { SubscriptionsResponse } from '@/components/rialto/providers/types'
import { api, type RequestLogItem, type SessionMessageItem } from '@/lib/api'
import type { UsageHistorySample, UsageWire } from './usage-derive'

export interface ActivityRequestLog extends RequestLogItem {
  /** Routing lane. Null on rows written before subagent capture landed. */
  isSubagent: boolean | null
}

export interface RequestLogPage {
  items: ActivityRequestLog[]
  total: number
}

/**
 * Newest-first page of upstream calls within a window.
 *
 * `sinceHours` of 0 is the whole archive, which is what callers that
 * only want `total` as an archive size pass. The Requests screen passes
 * its selected range instead, so the page and the total it is quoted
 * against describe the same population.
 */
export function fetchRequestLogs(limit: number, offset = 0, sinceHours = 0): Promise<RequestLogPage> {
  return api.get<RequestLogPage>(`/request-logs?limit=${limit}&offset=${offset}&sinceHours=${sinceHours}`)
}

/** Status mix and latency spread across a window. */
export interface RequestLogStats {
  total: number
  ok: number
  rateLimited: number
  failed: number
  /** Null when no row in the window reached an upstream. */
  p50: number | null
  p95: number | null
}

/**
 * The stat tiles' numbers, aggregated in Postgres over the whole window.
 *
 * Not derived from the page: a window can hold far more rows than one
 * request should carry, so folding it in the browser means folding a cap
 * — which is what made the tiles describe 25 rows under a "last 24h"
 * label.
 */
export function fetchRequestLogStats(sinceHours: number): Promise<RequestLogStats> {
  return api.get<RequestLogStats>(`/request-logs/stats?sinceHours=${sinceHours}`)
}

/** Newest-first page of one session's upstream calls; `total` is the whole session. */
export function fetchSessionRequestLogs(sessionId: string, limit: number, offset = 0): Promise<RequestLogPage> {
  return api.get<RequestLogPage>(
    `/request-logs/sessions/${encodeURIComponent(sessionId)}?limit=${limit}&offset=${offset}`
  )
}

export interface SessionMessagePage {
  /** Newest first — the wire sends each page oldest first, for a chat-style reader. */
  items: SessionMessageItem[]
  total: number
}

/** A page of one session's archived conversation, counted from the newest message. */
export function fetchSessionMessages(sessionId: string, limit: number, offset = 0): Promise<SessionMessagePage> {
  return api
    .get<{ items: SessionMessageItem[]; total: number }>(
      `/request-logs/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`
    )
    .then((res) => ({ items: [...res.items].reverse(), total: res.total }))
}

export interface UsageCostModelRow {
  model: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCostUsd: number | null
}

export interface UsageCostProviderRow {
  provider: string
  models: UsageCostModelRow[]
  totalCostUsd: number | null
  isSubscription: boolean
  subscriptionMonthlyUsd: number | null
}

export interface UsageCostResponse {
  providers: UsageCostProviderRow[]
  days: number
}

/**
 * Server-side aggregate over every RequestLog in the window. The session
 * list is paginated, so the headline numbers come from here instead of
 * from whatever page happens to be loaded.
 */
export function fetchUsageCost(days: number): Promise<UsageCostResponse> {
  return api.get<UsageCostResponse>(`/usage/cost?days=${days}`)
}

/**
 * Live subscription utilization, straight from each vendor's usage API.
 *
 * Overview reads the same numbers through `/api/overview`, which flattens
 * them to the account-wide 5h/7d pair. This endpoint keeps the per-model
 * weekly windows, which is why the Usage tab calls it directly rather
 * than reusing the overview payload.
 */
export function fetchUsage(): Promise<UsageWire> {
  return api.get<UsageWire>('/usage')
}

/** Captured utilization over the requested window. Server caps `days` at 30. */
export function fetchUsageHistory(days: number): Promise<{ samples: UsageHistorySample[] }> {
  return api.get<{ samples: UsageHistorySample[] }>(`/usage/history?days=${days}`)
}

/**
 * Which provider owns each subscription account, and the plan strings
 * its name is read from. `/api/usage` carries neither: it is one list per
 * vendor, and Claude's `rate_limit_tier` — the only thing that tells Max
 * 5x from Max 20x — lives only here.
 */
export function fetchSubscriptions(): Promise<SubscriptionsResponse> {
  return api.get<SubscriptionsResponse>('/subscriptions')
}

export interface WindowTotals {
  requests: number
  tokens: number
  /** Subscription providers are excluded: their traffic has no marginal cost. */
  apiKeyCostUsd: number | null
  /** Cache reads as a share of total input tokens, so long turns weigh more. */
  cacheHitRate: number | null
}

export function summariseUsageCost(res: UsageCostResponse): WindowTotals {
  const rows = res.providers.flatMap((p) => p.models.map((m) => ({ row: m, isSubscription: p.isSubscription })))
  const requests = rows.reduce((a, r) => a + r.row.requestCount, 0)
  const input = rows.reduce((a, r) => a + r.row.inputTokens + r.row.cacheReadTokens + r.row.cacheWriteTokens, 0)
  const output = rows.reduce((a, r) => a + r.row.outputTokens, 0)
  const cacheRead = rows.reduce((a, r) => a + r.row.cacheReadTokens, 0)
  const priced = rows.filter((r) => !r.isSubscription && r.row.totalCostUsd !== null)
  return {
    requests,
    tokens: input + output,
    apiKeyCostUsd:
      priced.length === 0
        ? null
        : priced.reduce((a, r) => a + (r.row.totalCostUsd === null ? 0 : r.row.totalCostUsd), 0),
    cacheHitRate: input === 0 ? null : cacheRead / input
  }
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null
  const idx = Math.min(ascending.length - 1, Math.floor((p / 100) * ascending.length))
  return ascending[idx]
}

export const TREND_BUCKETS = 7

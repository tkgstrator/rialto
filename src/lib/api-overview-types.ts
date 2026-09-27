import type { RoutingMode } from '@/lib/api-types'

export interface OverviewSurfaceTraffic {
  id: string
  path: string
  client: string
  routingMode: RoutingMode
  requests: number
  p50Ms: number | null
  errorRate: number | null
}

export interface OverviewSpendRow {
  label: 'today' | 'week' | 'month' | 'savedBySubscription'
  usd: number | null
  deltaRatio: number | null
}

export interface OverviewQuotaWindow {
  /** '5h' or '7d'. The per-model rows are also '7d'; `scope` separates them. */
  window: string
  /** Model name for a per-model weekly row, null for an account-wide one. */
  scope: string | null
  pct: number
  resetAt: string | null
}

/** One span of an account's traffic at API prices. Mirrors OverviewUsageFigures. */
export interface OverviewUsageFigures {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Null: traffic exists but none of it priced. 0: no traffic. */
  costUsd: number | null
}

export interface OverviewAccountUsage {
  windowStart: string
  window: OverviewUsageFigures
  last30d: OverviewUsageFigures
  monthlyPriceUsd: number | null
  valueRatio: number | null
}

export interface OverviewQuotaRow {
  subAccountId: string
  account: string
  windows: OverviewQuotaWindow[]
  usage: OverviewAccountUsage | null
  /** Codex banked resets; null for other accounts and before the first poll. */
  resetCredits: { available: number; applicable: number | null } | null
}

/** Fields, not prose — the sentence is composed and translated by the
 *  Overview screen. See FailoverRow in services/overview-service.ts. */
export interface OverviewFailoverRow {
  kind: 'rate_limit' | 'auth'
  tone: 'bad' | 'warn' | 'mute'
  at: string
  account: string
  status: number | null
  retryAfterSec: number | null
  /** auth rows: the probe's failure reason as the upstream gave it. */
  error: string | null
}

export interface OverviewRecentSession {
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
  surfaces: OverviewSurfaceTraffic[]
  spend: OverviewSpendRow[]
  quota: OverviewQuotaRow[]
  failover: OverviewFailoverRow[]
  recentSessions: OverviewRecentSession[]
}

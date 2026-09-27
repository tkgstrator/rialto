import type { AccountUsage } from './account-usage-service'

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
  usage: AccountUsage | null
  resetCredits: { available: number; applicable: number | null } | null
}

/**
 * One entry in the failover feed, carried as fields rather than as a
 * finished sentence.
 *
 * The server used to compose the prose here (`"<account> rate limited"`),
 * which put untranslated English on the landing page of a JA install.
 *
 * Two kinds, both something an operator acts on: an account refused with
 * a 429, and an account whose credential no longer authenticates. The
 * scheduler-weight moves this feed used to lead with went with the
 * weights: routing reads a route's quota directly, so there is no number
 * drifting between 1.00 and 0.60 to report.
 */
export interface FailoverRow {
  kind: 'rate_limit' | 'auth'
  tone: 'bad' | 'warn' | 'mute'
  at: string
  account: string
  // rate_limit
  status: number | null
  retryAfterSec: number | null
  // auth: the probe's own failure reason, shown as the upstream said it
  error: string | null
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

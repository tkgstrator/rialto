/**
 * Wire shapes for every `/api/*` response the browser reads.
 *
 * Split out of `api.ts` because these are consumed independently of the
 * client itself: a component that renders an `OverviewResponse` handed to
 * it by a parent imports the type and never touches `api`. `api.ts`
 * re-exports every name here, so `@/lib/api` remains the single import
 * path — nothing outside this pair should reference this module directly.
 */
export interface RequestLogItem {
  id: string
  sessionId: string
  provider: string
  model: string
  // What the client asked for pre-routing, and the routing lane it hit.
  // Null on rows written before routing capture landed.
  requestedModel: string | null
  scenario: string | null
  // Which inbound surface served the request (an `InboundSurface.id`
  // slug). Finer than inboundType: /v1/chat/completions and
  // /v1/responses are both 'openai'. Null on pre-migration rows.
  surface: string | null
  // Which issued AccessToken presented itself. The server has always sent
  // this; the type omitted it, so the Token column fell back to the
  // surface's client label and every /v1/messages row read "Claude Code".
  accessTokenId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalInputTokens: number
  cacheHitPct: number
  durationMs: number
  status: number
  createdAt: string
  inputCostUsd: number | null
  outputCostUsd: number | null
  cacheReadCostUsd: number | null
  totalCostUsd: number | null
}

// From the schema, not restated: the UI and the server must agree on
// what an inbound type can be, and a second copy is how they stop.
import type { InboundType } from '@/schemas/api/request-log'

export type { InboundType }

/** One model's share of a session. A session is rarely just one. */
export interface SessionModelUsage {
  name: string
  requests: number
}

export interface SessionSummary {
  sessionId: string
  // Wire format the session first came in on. Null on pre-migration
  // sessions.
  inboundType: InboundType | null
  // Surface of the session's most recent request; null when untracked.
  surface: string | null
  requestCount: number
  providers: string[]
  /** Every model the session used and how many requests each carried, busiest first. */
  models: SessionModelUsage[]
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  avgCacheHitPct: number
  totalDurationMs: number
  totalCostUsd: number | null
  firstAt: string
  lastAt: string
  preview: string | null
}

// One archived chat turn. Content is Anthropic-shaped block arrays for
// assistant rows, and either a string or a tool_result block array for
// user rows (Claude Code's tool-result turns). Kept as `unknown` on the
// wire — the renderer branches on shape at read time.
export interface SessionMessageItem {
  id: string
  role: string
  content: unknown
  createdAt: string
}

export interface HealthResponse {
  status: 'ok' | 'degraded'
  version: string
  uptime_seconds: number
  checks: Record<string, 'ok' | 'fail' | 'skip'>
}

/**
 * `GET /api/update/check`. Mirrors `UpdateCheckResponseSchema`.
 *
 * `status` is what makes the answer readable: `hasUpdate: false` alone
 * cannot say whether this install is current or whether the check never
 * got an answer, and the screen has to draw those differently.
 */
export interface UpdateCheckResponse {
  status: 'ok' | 'error'
  /** The version the server process is running, not the bundle's. */
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  changelog: string | null
  releaseUrl: string | null
  publishedAt: string | null
  checkedAt: string
  /** Why the check failed. Null when `status` is 'ok'. */
  message: string | null
}

export type SurfaceId = 'anthropic-messages' | 'openai-chat' | 'openai-responses' | 'gemini-generate'
export type RoutingMode = 'routed' | 'passthrough'

export interface InboundSurfaceWire {
  id: SurfaceId
  path: string
  client: string
  inboundType: 'anthropic' | 'openai' | 'gemini'
  auth: 'x-api-key' | 'bearer' | 'google'
  errorShape: 'anthropic' | 'openai' | 'google'
  routingMode: RoutingMode
  profileKey: string
  /** `provider,model` pairs refused on this surface while it is in passthrough. */
  deniedTargets: string[]
}

export interface AccessTokenWire {
  id: string
  name: string
  /** First characters only — identifies a token without being usable. */
  prefix: string
  /**
   * Inbound surfaces this token may call. Empty means every surface —
   * one client can legitimately speak more than one (Codex uses both
   * /v1/responses and /v1/chat/completions), which a single id could
   * only express by turning the scoping off.
   */
  surfaces: string[]
  profileKey: string | null
  lastUsedAt: string | null
  requestCount: number
  /**
   * USD this token's traffic cost over the server's trailing spend
   * window (30 days), not over its lifetime — `requestCount` is a
   * counter that outlives log retention and this is priced from the
   * logs, so the two are deliberately different spans. Null when
   * nothing priced: no traffic in the window, capture off, or a
   * subscription model with no per-token price.
   */
  costUsd: number | null
  /**
   * Input / output tokens moved over the same 30-day window `costUsd` is
   * priced from — so they pair with each other and with neither
   * `requestCount`, which is a lifetime counter.
   *
   * Null is "the window holds no rows for this token", which is not the
   * same null as `costUsd`'s: subscription traffic is logged with real
   * token counts and no price, so a row showing a dash for cost and a
   * number here is the expected reading, not a glitch.
   *
   * Cache reads and writes are counted in neither — they are priced on
   * their own terms, and folding them in here would not add up against
   * the cost sitting beside it.
   */
  inputTokens: number | null
  outputTokens: number | null
  expiresAt: string | null
  revokedAt: string | null
  /**
   * When the secret was last replaced, or null while the row still
   * carries the one it was issued with. Rotation keeps the row, so
   * `createdAt` is how long this client has existed and this is how old
   * the credential it presents actually is.
   */
  rotatedAt: string | null
  createdAt: string
}

export interface IdentityResponse {
  /** `local` = no credential presented or needed (a browser on the host). */
  mode: 'local' | 'cloudflare_access'
  email: string | null
  // False means nothing but a browser on the host can reach /api/*.
  accessConfigured: boolean
}

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

/** One subscription account and every limit it is under, shortest first. */
export interface OverviewQuotaRow {
  subAccountId: string
  account: string
  windows: OverviewQuotaWindow[]
}

/** Fields, not prose — the sentence is composed and translated by the
 *  Overview screen. See FailoverRow in services/overview-service.ts. */
export interface OverviewFailoverRow {
  kind: 'rate_limit' | 'weight'
  tone: 'bad' | 'warn' | 'mute'
  at: string
  account: string | null
  status: number | null
  retryAfterSec: number | null
  target: string | null
  fromWeight: number | null
  toWeight: number | null
  reason: string | null
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

export interface RouterPreferenceEntryWire {
  priority: number
  target: string
  enabled: boolean
  // Optional per-entry override of the global escalation / demotion
  // gates. Undefined = inherit the global constraint.
  allowEscalation?: boolean
  allowDemotion?: boolean
}

export type PreferenceScenarioKey = 'default' | 'think' | 'longContext' | 'webSearch' | 'image'
export type PreferenceKind = 'agent' | 'subagent'

// Each scenario carries two independent ordered chains: `agent` for
// main-agent traffic, `subagent` for requests carrying a
// <RIALTO-SUBAGENT-MODEL> tag. Both are always present so the UI can
// render an empty tab without a "missing" branch.
export interface PreferenceEntriesByKindWire {
  agent: RouterPreferenceEntryWire[]
  subagent: RouterPreferenceEntryWire[]
}

export type PreferenceEntriesByScenarioWire = Record<PreferenceScenarioKey, PreferenceEntriesByKindWire>

export interface RouterPreferenceProfileWire {
  entriesByScenario: PreferenceEntriesByScenarioWire
  constraints: Record<string, unknown> | null
}

export interface RouterPreferencesApplyResponse {
  success: boolean
  warnings: string[]
}

export interface RoutingSchedulerWeightEntry {
  target: string
  weight: number
  healthiness: number
  remainingBudgetPct: number | null
  earliestResetAt: string | null
  reasons: string[]
}

export interface RoutingSchedulerAccountView {
  subAccountId: string
  providerName: string
  kind: 'claude' | 'codex'
  fiveHour: { used: number; limit: number; resetAt: string | null } | null
  weekly: { used: number; limit: number; resetAt: string | null } | null
  refreshedAt: string | null
  stale: boolean
}

export interface RoutingSchedulerStateResponse {
  tickAt: string | null
  tickCount: number
  consecutiveFailures: number
  degraded: boolean
  weights: RoutingSchedulerWeightEntry[]
  accounts: RoutingSchedulerAccountView[]
  soonestResetAt: string | null
  recentChanges: Array<{ target: string; from: number; to: number; reason: string; tickAt: string }>
}

export interface RouterUtilizationPerScenarioRow {
  scenario: string
  total: number
  ok: number
  err429: number
  errOther: number
}

export interface RouterUtilizationPerTargetRow {
  requestedModel: string | null
  sentTo: string
  count: number
}

export interface RouterUtilizationPerAccountRow {
  subAccountId: string
  providerName: string
  kind: 'claude' | 'codex'
  currentBudgetPct: number | null
  fiveHourResetAt: string | null
  weeklyResetAt: string | null
  stale: boolean
}

export interface RouterUtilizationSuggestion {
  kind: 'primary_never_reached' | 'fallback_over_used' | 'exhausted_no_secondary'
  target: string
  detail: string
  proposedDiff: Record<string, unknown>
}

export interface RouterUtilizationResponse {
  windowHours: number
  generatedAt: string
  perScenario: RouterUtilizationPerScenarioRow[]
  perTarget: RouterUtilizationPerTargetRow[]
  perAccount: RouterUtilizationPerAccountRow[]
  suggestions: RouterUtilizationSuggestion[]
}

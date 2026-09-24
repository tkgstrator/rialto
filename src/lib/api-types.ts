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
  // What the client asked for pre-routing, and the scenario whose list
  // served it, or "passthrough". Rows v2.89.0 wrote carry a requested tier
  // instead. Null on rows written
  // before routing capture landed.
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

export interface RoutingSchedulerTargetState {
  target: string // "provider,model"
  exhausted: boolean // out of use on quota right now
  remainingBudgetPct: number | null // 0..100, null = unknown (api_key targets, cold start)
  projectedPct: number | null // use at the reset if the pace holds; over 100 steps down
  resetAt: string | null // ISO; when the binding window resets
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
  targets: RoutingSchedulerTargetState[]
  accounts: RoutingSchedulerAccountView[]
  soonestResetAt: string | null
}

// ─── Scenario routes and provider tier aliases ─────────────────────────
// Mirrors schemas/api/routing.ts. The stored shape (per scenario and lane,
// routes that name a provider and a tier) plus, on read, what each tier
// resolves to today and the Long context threshold in effect.

export type ModelTier = 'fable' | 'opus' | 'sonnet' | 'haiku'
export const MODEL_TIER_ORDER: readonly ModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']
/** Long input, thinking on, or neither. */
export type RoutingScenario = 'default' | 'think' | 'longContext'
export const ROUTING_SCENARIO_ORDER: readonly RoutingScenario[] = ['default', 'think', 'longContext']
/** Whether the request carried the subagent tag. */
export type RoutingLane = 'agent' | 'subagent'
export const ROUTING_LANE_ORDER: readonly RoutingLane[] = ['agent', 'subagent']

export interface TierRouteWire {
  provider: string
  targetTier: ModelTier
  enabled: boolean
}

export interface TierRouteResolutionWire {
  model: string
  /** The model and its provider are both switched on. */
  targetEnabled: boolean
  hostsWebSearch: boolean
  contextWindow: number | null
}

export interface TierRouteViewWire extends TierRouteWire {
  /** Null when the provider has no alias for `targetTier`. */
  resolved: TierRouteResolutionWire | null
}

export interface RoutingConstraintsWire {
  exhaustedBehavior: '429' | 'passthrough'
  quotaSkipPct: number
  errorRateSkipPct: number
  minHealthSamples: number
  /** The tuner's state; not edited on the screen. Null = the automatic base. */
  longContextThreshold: number | null
  previousLongContextThreshold: number | null
  longContextTunedAt: string | null
  autoTuneLongContext: boolean
}

export type ScenarioRoutesWire<R> = Record<RoutingScenario, Record<RoutingLane, R[]>>

export interface TierProfileViewWire {
  key: string
  routes: ScenarioRoutesWire<TierRouteViewWire>
  constraints: RoutingConstraintsWire
  /** Input tokens over which a request is Long context right now. */
  longContextThreshold: number
}

export interface TierProfileWriteWire {
  routes: ScenarioRoutesWire<TierRouteWire>
  constraints: RoutingConstraintsWire
}

export interface TierProfileSummaryWire {
  key: string
  routeCount: number
  updatedAt: string | null
  kind: 'map' | 'passthrough'
}

export interface TierProfileSaveOutcome {
  success: boolean
  warnings: string[]
}

export interface TierAliasWire {
  provider: string
  tier: ModelTier
  model: string | null
  updatedAt: string | null
  /** Models of this tier on the provider; `isNew` appeared after the alias was set. */
  candidates: Array<{ model: string; enabled: boolean; isNew: boolean }>
}

/** GET /api/subscriptions/accounts/{id}/reset-credits. Mirrors ResetCreditsResponse. */
export interface ResetCreditsResponse {
  credits: Array<{ id: string; grantedAt: string | null; expiresAt: string | null }>
  /** How many OpenAI would accept right now — 0 while no window is spent. */
  applicable: number | null
}

/** POST /api/subscriptions/accounts/{id}/reset-usage. Mirrors UseResetResponse. */
export interface UseResetResponse {
  spentCreditId: string
  remaining: number
  /** The follow-up usage poll answered, so routing already sees the reset. */
  refreshed: boolean
}

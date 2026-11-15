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
  // What the client asked for, and the scenario that served it: always
  // "passthrough" now, older rows carry the scenario list that served them
  // (or, from v2.89.0, a requested tier). Null on rows written before
  // routing capture landed.
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
  // The reasoning effort the request carried to the upstream, after Auto /
  // manual overrides. Null when none was set, and on pre-migration rows.
  reasoningEffort: string | null
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

/** One reasoning effort's share of a session; same shape as the model split. */
export interface SessionEffortUsage {
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
  /** The reasoning efforts its requests carried, busiest first; empty when none recorded one. */
  efforts: SessionEffortUsage[]
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

export type SurfaceId = 'anthropic-messages' | 'openai-chat' | 'openai-responses' | 'gemini-generate' | 'openai-images'

/**
 * What a token's scope list may hold: the inbound surfaces, plus the Codex
 * MCP server at /codex (`CODEX_MCP_SCOPE` in @/shared/codex-mcp).
 *
 * Kept apart from SurfaceId on purpose. /codex is not an inbound surface —
 * `/api/inbound-surfaces` never lists it and nothing routes it — so every
 * picker that asks "which surface" (personas) must keep taking
 * SurfaceId and cannot be handed this one by mistake.
 */
export type TokenScopeId = SurfaceId | 'codex-mcp'

export interface InboundSurfaceWire {
  id: SurfaceId
  path: string
  client: string
  inboundType: 'anthropic' | 'openai' | 'gemini'
  auth: 'x-api-key' | 'bearer' | 'google'
  errorShape: 'anthropic' | 'openai' | 'google'
  /** `provider,model` pairs refused on this surface. */
  deniedTargets: string[]
}

/**
 * Revoked tokens' traffic over the same trailing window as a token's
 * `costUsd`. Revoking deletes the row, so this is where that spend still
 * shows; a per-token breakdown without it would inflate the survivors'
 * shares.
 */
export interface RevokedTokensWire {
  requestCount: number
  costUsd: number | null
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
   *
   * 'codex-mcp' shares the list but not that rule: the empty list does
   * not reach /codex, which is only ever granted by naming it. So
   * ['codex-mcp'] alone is "the MCP server and no /v1 surface", not
   * "every surface".
   */
  surfaces: TokenScopeId[]
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
  /**
   * When the secret was last replaced, or null while the row still
   * carries the one it was issued with. Rotation keeps the row, so
   * `createdAt` is how long this client has existed and this is how old
   * the credential it presents actually is.
   */
  rotatedAt: string | null
  createdAt: string
  /** The plan this token spends under. Null = unrestricted. */
  plan: { id: string; name: string } | null
}

export interface IdentityResponse {
  /** `local` = no credential presented or needed (a browser on the host). */
  mode: 'local' | 'cloudflare_access'
  email: string | null
  // False means nothing but a browser on the host can reach /api/*.
  accessConfigured: boolean
}

export type * from '@/lib/api-overview-types'

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

/**
 * A plan: the models a token on it may use and its usage-window limits.
 * Tokens reference it, so an edit reaches every token on it at once.
 */
export interface PlanWire {
  id: string
  name: string
  /** `provider,model` ids a request may name. */
  models: string[]
  /** Where any other model name, or none, is sent. Always one of `models`. */
  defaultModel: string
  /** Completions admitted per 5-hour window. Null = no limit. */
  fiveHourRequestLimit: number | null
  /** USD spent per 5-hour window. Null = no limit. */
  fiveHourSpendLimitUsd: number | null
  /** Completions admitted per 7-day window. Null = no limit. */
  sevenDayRequestLimit: number | null
  /** USD spent per 7-day window. Null = no limit. */
  sevenDaySpendLimitUsd: number | null
  tokenCount: number
  createdAt: string
  updatedAt: string
}

export interface PlanInputWire {
  name: string
  models: string[]
  defaultModel: string
  fiveHourRequestLimit: number | null
  fiveHourSpendLimitUsd: number | null
  sevenDayRequestLimit: number | null
  sevenDaySpendLimitUsd: number | null
}

/** One of a token's usage windows. GET /api/access-tokens/{id}/usage-windows. */
export interface UsageWindowWire {
  window: '5h' | '7d'
  /** Null while no window is open — nothing counted since the last one ended. */
  startedAt: string | null
  resetsAt: string | null
  requests: number
  requestLimit: number | null
  costUsd: number
  spendLimitUsd: number | null
}

export interface TokenUsageWindowsWire {
  /** False when the token's plan sets no limit, or it has no plan. */
  limited: boolean
  windows: UsageWindowWire[]
}

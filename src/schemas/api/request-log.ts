/**
 * The archive endpoints: session listings, request logs, archived
 * messages, and the requested-vs-actual model routing report.
 *
 * These are all read models — shapes assembled for a screen rather than
 * stored anywhere in this form — which is what keeps them out of domain.
 */

import { z } from '@hono/zod-openapi'

// The wire formats Rialto accepts, mirroring `InboundSurface.inboundType`.
// Coarser than `surface`: both OpenAI-compat surfaces report 'openai'.
export const InboundTypeSchema = z.enum(['anthropic', 'openai', 'gemini'])
export type InboundType = z.infer<typeof InboundTypeSchema>

export const SessionModelUsageSchema = z.object({
  name: z.string().nonempty(),
  requests: z.number().int().positive()
})

export const SessionSummarySchema = z.object({
  sessionId: z.string().nonempty(),
  // Which wire format the session first came in on. Null on
  // pre-migration sessions.
  inboundType: InboundTypeSchema.nullable(),
  // Surface of the session's most recent request. A session normally
  // stays on one surface for its whole life, so this is the session's
  // surface in practice; it is derived rather than stored because
  // Session predates the column.
  surface: z.string().nonempty().nullable(),
  requestCount: z.number().int().nonnegative(),
  providers: z.array(z.string().nonempty()),
  // Every model the session used and how many of its requests each
  // carried, busiest first. Not one model: routing moves a session
  // between them turn by turn, and the list used to be an unordered set
  // whose first element the UI showed as "the" model.
  models: z.array(SessionModelUsageSchema),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCacheReadTokens: z.number().int().nonnegative(),
  totalCacheWriteTokens: z.number().int().nonnegative(),
  // Average across int rows — kept as a plain number to allow fractional values.
  avgCacheHitPct: z.number(),
  totalDurationMs: z.number().int().nonnegative(),
  totalCostUsd: z.number().nullable(),
  firstAt: z.string().nonempty(),
  lastAt: z.string().nonempty(),
  // First user text turn, truncated, so the list can show a chat-style
  // preview. Null when no user text has been archived yet (e.g. the first
  // turn is a tool_result-only reply).
  preview: z.string().nonempty().nullable()
})

export const RequestLogItemSchema = z.object({
  id: z.string().nonempty(),
  sessionId: z.string().nonempty(),
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  // What the client asked for pre-routing, and the routing lane it hit.
  // Null on rows written before routing capture landed.
  requestedModel: z.string().nullable(),
  scenario: z.string().nullable(),
  // Which inbound surface served the request, as an `InboundSurface.id`
  // slug. Finer than `inboundType`, which cannot tell
  // /v1/chat/completions from /v1/responses. Null on rows written before
  // the column landed — render those as untracked, never as a guess.
  surface: z.string().nonempty().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  // Prisma column is Int — single-request hit percent is a whole-number percentage.
  cacheHitPct: z.number().int().min(0).max(100),
  durationMs: z.number().int().nonnegative(),
  status: z.number().int(),
  createdAt: z.string().nonempty(),
  inputCostUsd: z.number().nullable(),
  outputCostUsd: z.number().nullable(),
  cacheReadCostUsd: z.number().nullable(),
  totalCostUsd: z.number().nullable()
})

// Paginated list query params: ?limit&offset&sinceHours.
export const RequestLogsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  // Only return rows created within the last N hours (0 = no time
  // limit). Defaults to 0 so callers that just want the archive's size
  // keep the answer they had; the Requests screen passes its selected
  // range, which is what makes `total` a count of the window rather
  // than of everything ever logged.
  sinceHours: z.coerce.number().int().min(0).max(8760).default(0)
})

// Window aggregate query params: ?sinceHours (0 = the whole archive).
export const RequestLogStatsQuerySchema = z.object({
  sinceHours: z.coerce.number().int().min(0).max(8760).default(24)
})

/**
 * Status mix and latency spread over a time window.
 *
 * Separate from the list response because the two answer different
 * questions and are read at different sizes: the list hands back one
 * page, this summarises every row in the window. Computing it in the
 * browser from the page — which is what the Requests screen used to do —
 * produced tiles that described 25 rows while claiming to describe the
 * last 24 hours.
 *
 * `p50` / `p95` are null when the window holds no row with a measured
 * duration: a 429 never reaches an upstream, so it has no latency to
 * contribute, and a window of nothing but 429s has no percentile rather
 * than a zero one.
 */
export const RequestLogStatsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  rateLimited: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  p50: z.number().nullable(),
  p95: z.number().nullable()
})

export const RequestLogsSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  // Only return sessions active within the last N hours (0 = no time limit).
  // History tends to grow unbounded, so default to a recent window.
  sinceHours: z.coerce.number().int().min(0).max(8760).default(6),
  // Filter by inbound wire type. 'anthropic' = Claude Code (/v1/messages),
  // 'openai' = /v1/chat/completions + /v1/responses, 'gemini' =
  // /v1beta/models/*. Omit for "all".
  inboundType: InboundTypeSchema.optional()
})

export const SessionIdParamSchema = z.object({ sessionId: z.string().nonempty() })
export const RequestLogIdParamSchema = z.object({ id: z.string().nonempty() })

export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  total: z.number().int().nonnegative()
})

export const SessionLogsResponseSchema = z.object({
  items: z.array(RequestLogItemSchema)
})

export const RequestLogsListResponseSchema = z.object({
  items: z.array(RequestLogItemSchema),
  total: z.number().int().nonnegative()
})

// Archive-all response: number of active sessions moved to the archive.
export const SessionsArchiveResponseSchema = z.object({ archived: z.number().int().nonnegative() })

export const RequestLogsDeleteOneResponseSchema = z.object({ id: z.string().nonempty() })

// One archived chat message. `content` intentionally stays `unknown` — it
// is an Anthropic-shaped block array on assistant rows, and a string or
// block array on user rows (Claude Code's tool_result turns).
export const SessionMessageItemSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.unknown(),
  createdAt: z.string()
})

// Cursor pagination for a session's messages. The client fetches the
// newest window first (no cursor), then pages older-and-older by passing
// `before` = the id of the oldest message currently in view.
export const SessionMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().nonempty().optional()
})

export const SessionMessagesResponseSchema = z.object({
  // Ascending by createdAt so the client can render top-to-bottom.
  items: z.array(SessionMessageItemSchema),
  // Id of the OLDEST message returned in this page, iff older history
  // remains. Pass it back as `before` to fetch the next older window.
  // Null when the page reached the beginning of the session.
  nextCursor: z.string().nullable()
})

// ─── Model-routing report ──────────────────────────────────────────────
// Cross-tab of "what the client requested" → "what Rialto actually sent".
// Answers: how often is each requested model honored vs rerouted, and to
// which provider/model/scenario.

export const ModelRoutingQuerySchema = z.object({
  // Only count rows created within the last N hours (0 = all time).
  sinceHours: z.coerce.number().int().min(0).max(8760).default(0)
})

// One actual upstream target a requested model was routed to.
export const ModelRoutingTargetSchema = z.object({
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  // Routing lane (default/background/think/longContext/webSearch). Null on
  // rows written before scenario capture landed.
  scenario: z.string().nullable(),
  // Whether the target was reached via the subagent lane. The API drops
  // pre-tracking rows (isSubagent IS NULL) so the response always carries
  // a boolean here.
  isSubagent: z.boolean(),
  count: z.number().int().nonnegative()
})

// All targets a single requested model fanned out to, with its total.
export const ModelRoutingRowSchema = z.object({
  // The client's original body.model. Null bucket = rows written before
  // routing capture landed ("untracked").
  requestedModel: z.string().nullable(),
  total: z.number().int().nonnegative(),
  targets: z.array(ModelRoutingTargetSchema)
})

export const ModelRoutingResponseSchema = z.object({
  rows: z.array(ModelRoutingRowSchema),
  // Grand total of request_logs rows counted (across all requested models).
  total: z.number().int().nonnegative()
})

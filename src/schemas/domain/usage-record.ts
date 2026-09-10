/**
 * Schemas the pipeline uses to extract token-usage stats from upstream
 * responses (JSON and SSE).
 *
 * The shape unifies the fields Anthropic and OpenAI publish. Every
 * field is optional because providers differ; the consumer treats
 * missing fields as zero.
 */

import { z } from '@hono/zod-openapi'

// ─── Unified usage block ───────────────────────────────────────────────

export const UsageBlockSchema = z.object({
  // Anthropic
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  // OpenAI Chat Completions
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  // OpenAI: the cached-input breakdown. The two surfaces spell the same
  // number differently — Chat Completions puts it under
  // `prompt_tokens_details`, Responses under `input_tokens_details` —
  // and declaring only one of them silently records every Chat cache hit
  // as zero, which overstates cost in the Activity view.
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
  // Gemini. Not a stylistic variant of the two above — without these the
  // block never parses for a Google upstream, `extractUsage` returns
  // null, and `captureUsage` returns before writing anything, so Gemini
  // traffic leaves no RequestLog row at all rather than an incomplete
  // one. Like OpenAI (and unlike Anthropic), `promptTokenCount` already
  // contains `cachedContentTokenCount` — the SDK says so verbatim:
  // "When `cached_content` is set, this also includes the number of
  // tokens in the cached content."
  promptTokenCount: z.number().int().nonnegative().optional(),
  candidatesTokenCount: z.number().int().nonnegative().optional(),
  cachedContentTokenCount: z.number().int().nonnegative().optional()
})
export type UsageBlock = z.infer<typeof UsageBlockSchema>

// ─── Non-stream JSON response envelope ─────────────────────────────────

export const JsonResponseWithUsageSchema = z.object({
  usage: UsageBlockSchema.optional(),
  // Gemini hangs its counters off the response root under a different
  // key rather than nesting them in `usage`.
  usageMetadata: UsageBlockSchema.optional()
})
export type JsonResponseWithUsage = z.infer<typeof JsonResponseWithUsageSchema>

// ─── SSE event envelopes carrying usage ────────────────────────────────

// Anthropic SSE: `event: message_start` — full usage block on `.message.usage`.
export const AnthropicMessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({ usage: UsageBlockSchema })
})

// Anthropic SSE: `event: message_delta` — partial usage on the event itself.
export const AnthropicMessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  usage: UsageBlockSchema
})

// OpenAI Responses SSE: `event: response.completed` — full usage on `.response.usage`.
export const ResponsesCompletedEventSchema = z.object({
  type: z.literal('response.completed'),
  response: z.object({ usage: UsageBlockSchema })
})

// OpenAI Chat Completions SSE: the last chunk MAY carry a top-level
// usage object alongside the rest of its fields. No discriminator —
// match by presence of `usage.prompt_tokens`.
export const ChatCompletionUsageChunkSchema = z.object({
  usage: UsageBlockSchema.refine(
    (u): u is UsageBlock & { prompt_tokens: number } => typeof u.prompt_tokens === 'number'
  )
})

// Gemini SSE: every `streamGenerateContent` chunk MAY carry usageMetadata,
// and the counts are cumulative, so the last one seen wins. Matched by
// presence of `promptTokenCount` for the same reason as above — there is
// no event type to discriminate on.
export const GeminiUsageChunkSchema = z.object({
  usageMetadata: UsageBlockSchema.refine(
    (u): u is UsageBlock & { promptTokenCount: number } => typeof u.promptTokenCount === 'number'
  )
})

// ─── Persisted request-log row (UsageRecord) ───────────────────────────

/**
 * What the pipeline writes to the `request_logs` table after a
 * successful upstream call. Pure data — every field is required
 * because the consumer (`recordUsage` deps callback) writes it
 * straight into Prisma.
 */
export const UsageRecordSchema = z.object({
  sessionId: z.string().nonempty(),
  provider: z.string().nonempty(),
  model: z.string().nonempty(),
  // The client's original body.model (pre-routing) and the routing lane
  // it landed on. Null when the capture site couldn't read them (e.g. a
  // request that bypassed scenario routing) — the DB columns are nullable
  // for the same reason.
  requestedModel: z.string().nonempty().nullable(),
  scenario: z.string().nonempty().nullable(),
  // Which wire format the request came in on. 'anthropic' for
  // /v1/messages (Claude Code), 'openai' for /v1/chat/completions and
  // /v1/responses, 'gemini' for /v1beta/models/*. Null for rows written
  // before this landed (backfill is not possible — the inbound path is
  // not recoverable from stored fields). Persisted on both RequestLog
  // and Session (first-observed).
  inboundType: z.enum(['anthropic', 'openai', 'gemini']).nullable(),
  // Which inbound surface the request arrived on, as an
  // `InboundSurface.id` slug. Distinguishes the two OpenAI-compat
  // surfaces, which `inboundType` collapses into one bucket. Null for
  // pre-migration rows and for paths outside the registry.
  surface: z.string().nonempty().nullable(),
  // Which AccessToken authenticated the request. Null for rows predating
  // tokens, and for traffic on the since-removed envelope bootstrap token.
  accessTokenId: z.string().nonempty().nullable(),
  // Whether the request took the subagent lane (a <RIALTO-SUBAGENT-MODEL>
  // tag was present). Always known at write — the route builder stamps
  // it before the pipeline runs, so this stays a plain boolean.
  isSubagent: z.boolean(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  cacheHitPct: z.number().int().min(0).max(100),
  durationMs: z.number().int().nonnegative(),
  status: z.number().int()
})
export type UsageRecord = z.infer<typeof UsageRecordSchema>

// One row per chat turn to append to the Message table. The pipeline
// emits these alongside UsageRecord: one 'user' entry for the last user
// block on request send, and one 'assistant' entry with the assembled
// text / tool_use blocks once the response stream completes. content is
// the Anthropic wire block array, tool_use `input` is truncated to keep
// storage bounded.
export const MessageRecordSchema = z.object({
  sessionId: z.string().nonempty(),
  role: z.enum(['user', 'assistant']),
  content: z.unknown()
})
export type MessageRecord = z.infer<typeof MessageRecordSchema>

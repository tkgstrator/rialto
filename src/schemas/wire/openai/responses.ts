/**
 * Zod schemas for the OpenAI Responses API (`/v1/responses`).
 *
 * These describe the wire-level shapes the OpenAIResponsesTransformer
 * parses out of upstream replies (both the non-streaming JSON envelope
 * and the streaming SSE events). Field types are intentionally loose —
 * upstream omits or renames keys across model families, so we keep
 * everything optional and `safeParse` defensively at the boundary.
 *
 * For fields where the original transformer used `?? '<empty>'`
 * fallbacks, the schema uses `.default(...)` so consumers can read
 * fields directly without a fallback expression at the call site.
 */

import { z } from '@hono/zod-openapi'
import { UnifiedChatRequestSchema } from '@/schemas/domain/unified'

// ─── Annotation block on output_text content ───────────────────────────

// Upstream omits these inconsistently per model family. Defaults keep
// downstream consumers fallback-free.
export const ResponsesAnnotationSchema = z.object({
  url: z.string().default(''),
  title: z.string().default(''),
  start_index: z.number().int().nonnegative().default(0),
  end_index: z.number().int().nonnegative().default(0)
})
export type ResponsesAnnotation = z.infer<typeof ResponsesAnnotationSchema>

// ─── Output content blocks (JSON payload) ──────────────────────────────

export const ResponsesAPIOutputContentSchema = z.object({
  type: z.string().nonempty(),
  text: z.string().nonempty().optional(),
  image_url: z.string().nonempty().optional(),
  mime_type: z.string().nonempty().optional(),
  image_base64: z.string().nonempty().optional(),
  annotations: z.array(ResponsesAnnotationSchema).default([])
})
export type ResponsesAPIOutputContent = z.infer<typeof ResponsesAPIOutputContentSchema>

// ─── Output items (message / function_call) ────────────────────────────

export const ResponsesAPIOutputItemSchema = z.object({
  type: z.string().nonempty(),
  id: z.string().nonempty().optional(),
  call_id: z.string().nonempty().optional(),
  name: z.string().nonempty().optional(),
  arguments: z.string().nonempty().optional(),
  content: z.array(ResponsesAPIOutputContentSchema).default([]),
  reasoning: z.string().nonempty().optional()
})
export type ResponsesAPIOutputItem = z.infer<typeof ResponsesAPIOutputItemSchema>

// ─── Non-streaming JSON response envelope ──────────────────────────────

export const ResponsesAPIPayloadSchema = z.object({
  id: z.string().nonempty().optional(),
  object: z.string().nonempty().optional(),
  model: z.string().nonempty().optional(),
  created_at: z.number().int().nonnegative().optional(),
  output: z.array(ResponsesAPIOutputItemSchema).default([]),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative()
    })
    .optional()
})
export type ResponsesAPIPayload = z.infer<typeof ResponsesAPIPayloadSchema>

// ─── Streaming output_item.added inner item ────────────────────────────

export const ResponsesStreamItemContentSchema = z.object({
  type: z.string().nonempty(),
  text: z.string().nonempty().optional(),
  image_url: z.string().nonempty().optional(),
  mime_type: z.string().nonempty().optional()
})
export type ResponsesStreamItemContent = z.infer<typeof ResponsesStreamItemContentSchema>

export const ResponsesStreamItemSchema = z.object({
  id: z.string().nonempty().optional(),
  type: z.string().nonempty().optional(),
  call_id: z.string().nonempty().optional(),
  name: z.string().nonempty().optional(),
  content: z.array(ResponsesStreamItemContentSchema).default([]),
  reasoning: z.string().nonempty().optional()
})
export type ResponsesStreamItem = z.infer<typeof ResponsesStreamItemSchema>

// ─── Streaming SSE event envelope ──────────────────────────────────────

// `delta` is sometimes a string (text deltas) and sometimes an object
// (image base64 deltas). Modelled as a union.
export const ResponsesStreamDeltaSchema = z.union([
  z.string().nonempty(),
  z.object({
    url: z.string().nonempty().optional(),
    b64_json: z.string().nonempty().optional(),
    mime_type: z.string().nonempty().optional()
  })
])
export type ResponsesStreamDelta = z.infer<typeof ResponsesStreamDeltaSchema>

// What a Responses backend says when it fails after opening the stream.
// The Codex backend does that with the 200 already sent, so the status
// line cannot carry it: `response.failed` puts it on `response.error`,
// and a bare `error` event puts `code` / `message` at the top level (or
// under `error`). The leaves are `unknown` on purpose — an event that
// fails to parse is dropped, and a dropped failure is exactly the silent
// empty stream this is read to prevent.
export const ResponsesStreamFailureSchema = z
  .object({
    type: z.unknown().optional(),
    code: z.unknown().optional(),
    message: z.unknown().optional()
  })
  .loose()
export type ResponsesStreamFailure = z.infer<typeof ResponsesStreamFailureSchema>

export const ResponsesStreamEventSchema = z.object({
  type: z.string().nonempty(),
  item_id: z.string().nonempty().optional(),
  output_index: z.number().int().nonnegative().optional(),
  delta: ResponsesStreamDeltaSchema.optional(),
  item: ResponsesStreamItemSchema.optional(),
  response: z
    .object({
      id: z.string().nonempty().optional(),
      model: z.string().nonempty().optional(),
      output: z.array(z.object({ type: z.string().nonempty() })).default([]),
      // Codex publishes usage on `response.completed` only; the value
      // is optional / null on the earlier `response.created` /
      // `response.in_progress` events. Modelled here so Zod doesn't
      // strip it before the completed-chunk builder reads it.
      // `.nullish()` rather than `.optional()`: codex sends an explicit
      // `"usage": null` on those earlier events, which `.optional()`
      // rejects — the whole event then failed to parse and leaked into
      // the chat-completions stream as a raw Responses payload.
      usage: z
        .object({
          input_tokens: z.number().int().nonnegative().optional(),
          output_tokens: z.number().int().nonnegative().optional(),
          total_tokens: z.number().int().nonnegative().optional()
        })
        .loose()
        .nullish(),
      // Null on every event but the one that ends the response.
      error: ResponsesStreamFailureSchema.nullish(),
      incomplete_details: z.object({ reason: z.unknown().optional() }).loose().nullish()
    })
    .loose()
    .optional(),
  annotation: ResponsesAnnotationSchema.optional(),
  part: z.unknown().optional(),
  reasoning_summary: z.string().nonempty().optional(),
  // The bare `error` event's own fields.
  code: z.unknown().optional(),
  message: z.unknown().optional(),
  error: ResponsesStreamFailureSchema.nullish()
})
export type ResponsesStreamEvent = z.infer<typeof ResponsesStreamEventSchema>

// ─── Codex (ChatGPT subscription) request shape ────────────────────────
//
// The Codex backend (chatgpt.com/backend-api/codex) requires several
// Responses-API fields that the unified chat request schema doesn't
// model. codex-oauth populates them just-in-time before sending.

export const CodexRequestShapeSchema = UnifiedChatRequestSchema.extend({
  store: z.boolean().default(false),
  instructions: z.string().min(0).optional(),
  prompt_cache_key: z.string().nonempty().optional(),
  input: z.unknown().optional()
})
export type CodexRequestShape = z.input<typeof CodexRequestShapeSchema>

// ─── Responses-API request shape ───────────────────────────────────────
//
// `openai-responses` transforms a UnifiedChatRequest into this shape
// (which adds `instructions` / `input` / `parallel_tool_calls`) before
// the body hits the upstream endpoint.

export const ResponsesUnifiedChatRequestSchema = UnifiedChatRequestSchema.extend({
  instructions: z.string().min(0).optional(),
  input: z.array(z.unknown()).default([]),
  parallel_tool_calls: z.boolean().default(false),
  // The output ceiling under the name this surface uses. Unified spells
  // it `max_tokens` and gpt-5.x chat wants `max_completion_tokens`;
  // `openai-responses` translates whichever arrived into this one.
  max_output_tokens: z.number().int().positive().optional()
})
export type ResponsesUnifiedChatRequest = z.input<typeof ResponsesUnifiedChatRequestSchema>

// ─── /v1/responses INBOUND request-body shapes ─────────────────────────
//
// Mirror of the OpenAI Responses API wire shape as it arrives on our
// inbound endpoint. The reverse of the schemas above — those describe
// what Rialto SENDS to a Responses upstream; these describe what Rialto
// RECEIVES from an OpenAI-client caller (Codex CLI, Cline in
// Responses-mode, direct curl).
//
// The item-level union is loose (`z.union` of `.loose()` schemas) so
// unknown item kinds fall through unmodified rather than throwing a
// schema violation — the inbound converter drops them silently.

export const ResponsesInboundContentBlockSchema = z
  .object({
    type: z.string().nonempty(),
    text: z.string().min(0).optional(),
    image_url: z.union([z.string().nonempty(), z.object({ url: z.string().nonempty() })]).optional()
  })
  .loose()
export type ResponsesInboundContentBlock = z.infer<typeof ResponsesInboundContentBlockSchema>

export const ResponsesInboundMessageItemSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.string().nonempty().optional(),
    content: z.union([z.string().min(0), z.array(ResponsesInboundContentBlockSchema)]).optional()
  })
  .loose()
export type ResponsesInboundMessageItem = z.infer<typeof ResponsesInboundMessageItemSchema>

export const ResponsesInboundFunctionCallItemSchema = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().nonempty().optional(),
    id: z.string().nonempty().optional(),
    name: z.string().min(0).optional(),
    arguments: z.string().min(0).optional()
  })
  .loose()
export type ResponsesInboundFunctionCallItem = z.infer<typeof ResponsesInboundFunctionCallItemSchema>

export const ResponsesInboundFunctionCallOutputItemSchema = z
  .object({
    type: z.literal('function_call_output'),
    call_id: z.string().nonempty().optional(),
    output: z.unknown().optional()
  })
  .loose()
export type ResponsesInboundFunctionCallOutputItem = z.infer<typeof ResponsesInboundFunctionCallOutputItemSchema>

export const ResponsesInboundInputItemSchema = z.union([
  ResponsesInboundFunctionCallItemSchema,
  ResponsesInboundFunctionCallOutputItemSchema,
  ResponsesInboundMessageItemSchema
])
export type ResponsesInboundInputItem = z.infer<typeof ResponsesInboundInputItemSchema>

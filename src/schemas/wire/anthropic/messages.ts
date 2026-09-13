/**
 * The `/v1/messages` request body exactly as Anthropic defines it.
 *
 * Lives in wire/ rather than domain/ because nothing here is ours to
 * choose: the field names, the tool families and the tool_choice union
 * are Anthropic's, and they change when Anthropic changes them. The
 * Anthropic transformer parses through these on the way in and converts
 * to the unified domain shape, so the rest of the pipeline never sees a
 * vendor field name.
 */

import { z } from '@hono/zod-openapi'
// The one place the wire layer reaches into domain/: an Anthropic custom
// tool's `input_schema` is JSON Schema, identical to the parameters
// object on a unified tool. Re-declaring it would let the two drift.
import { UnifiedFunctionToolSchema } from '@/schemas/domain/unified'

// ─── Anthropic incoming request shapes ─────────────────────────────────
// Schemas for the inbound `/v1/messages` payload. The Anthropic
// transformer parses requests through these schemas so the conversion
// to the unified shape can rely on narrowed, optional-aware types
// instead of `as`-cast structural types.

export const AnthropicCacheControlSchema = z.object({
  // When a cache_control block is present, Anthropic mandates the
  // discriminator (currently always "ephemeral"). Optional removed.
  type: z.string().nonempty()
})
export type AnthropicCacheControl = z.input<typeof AnthropicCacheControlSchema>

export const AnthropicSystemBlockSchema = z.object({
  // A system block is always `{ type: "text", text: "..." }` on the
  // wire — both fields are required when the block is present.
  type: z.string().nonempty(),
  text: z.string().nonempty(),
  cache_control: AnthropicCacheControlSchema.optional()
})
export type AnthropicSystemBlock = z.input<typeof AnthropicSystemBlockSchema>

// Anthropic image blocks come in two shapes — base64 (data + media_type)
// or url (url + media_type). Discriminated by `type` so consumers narrow
// without re-checking each subfield.
export const AnthropicBase64ImageSourceSchema = z.object({
  type: z.literal('base64'),
  media_type: z.string().nonempty(),
  data: z.string().nonempty()
})
export const AnthropicUrlImageSourceSchema = z.object({
  type: z.literal('url'),
  media_type: z.string().nonempty(),
  url: z.string().nonempty()
})
export const AnthropicImageSourceSchema = z.discriminatedUnion('type', [
  AnthropicBase64ImageSourceSchema,
  AnthropicUrlImageSourceSchema
])
export type AnthropicImageSource = z.input<typeof AnthropicImageSourceSchema>

export const AnthropicContentBlockSchema = z.object({
  type: z.string().nonempty(),
  text: z.string().nonempty().optional(),
  id: z.string().nonempty().optional(),
  name: z.string().nonempty().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().nonempty().optional(),
  content: z.unknown().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
  source: AnthropicImageSourceSchema.optional(),
  thinking: z.string().min(0).optional(),
  signature: z.string().nonempty().optional()
})
export type AnthropicContentBlock = z.input<typeof AnthropicContentBlockSchema>

export const AnthropicIncomingMessageSchema = z.object({
  role: z.string().nonempty(),
  content: z.union([z.string().nonempty(), z.array(AnthropicContentBlockSchema)])
})
export type AnthropicIncomingMessage = z.input<typeof AnthropicIncomingMessageSchema>

// Anthropic ships two families of tool blocks on `/v1/messages` request:
//
//   1. Custom tools — the model calls user-defined functions. Requires
//      `name`, `description`, `input_schema`. `type` may be absent
//      (Anthropic defaults it to "custom") or explicitly "custom".
//   2. Server-side tools — Anthropic hosts the tool. Identified by a
//      versioned `type` (e.g. `web_search_20250305`, `computer_20250124`,
//      `bash_20250124`, `text_editor_20250124`, `code_execution_20250522`).
//      They only carry `type` and `name`, no description / input_schema,
//      and may carry tool-specific extras (`max_uses`, `display_width_px`,
//      …) which we let through untouched.
//
// Prior to this split the schema was a single object with description /
// input_schema required, which rejected every server-tool payload — see
// scenario-router/model-selection.ts which already recognised the
// `{ type: 'web_search_*' }` shape at the routing layer.
const AnthropicServerToolTypeSchema = z.string().regex(/^(web_search|computer|bash|text_editor|code_execution)_/)

export const AnthropicCustomToolDefSchema = z.object({
  type: z.literal('custom').optional(),
  name: z.string().nonempty(),
  // Anthropic API requires `description` on every custom tool
  // definition — the docs treat it as load-bearing for model tool
  // selection.
  description: z.string().nonempty(),
  input_schema: UnifiedFunctionToolSchema.shape.function.shape.parameters,
  cache_control: AnthropicCacheControlSchema.optional()
})
export type AnthropicCustomToolDef = z.input<typeof AnthropicCustomToolDefSchema>

export const AnthropicServerToolDefSchema = z
  .object({
    type: AnthropicServerToolTypeSchema,
    name: z.string().nonempty(),
    cache_control: AnthropicCacheControlSchema.optional()
  })
  .catchall(z.unknown())
export type AnthropicServerToolDef = z.input<typeof AnthropicServerToolDefSchema>

export const AnthropicToolDefSchema = z.union([AnthropicServerToolDefSchema, AnthropicCustomToolDefSchema])
export type AnthropicToolDef = z.input<typeof AnthropicToolDefSchema>

// Anthropic tool_choice is one of: `auto` / `any` / `none` (no extra
// fields) or `tool` (which mandates the target `name`). Modelling as a
// discriminated union pulls the `name === undefined` defensive guard
// in the consumer up to schema-time.
export const AnthropicAutoToolChoiceSchema = z.object({ type: z.literal('auto') })
export const AnthropicAnyToolChoiceSchema = z.object({ type: z.literal('any') })
export const AnthropicNoneToolChoiceSchema = z.object({ type: z.literal('none') })
export const AnthropicSpecificToolChoiceSchema = z.object({
  type: z.literal('tool'),
  name: z.string().nonempty()
})
export const AnthropicToolChoiceSchema = z.discriminatedUnion('type', [
  AnthropicAutoToolChoiceSchema,
  AnthropicAnyToolChoiceSchema,
  AnthropicNoneToolChoiceSchema,
  AnthropicSpecificToolChoiceSchema
])
export type AnthropicToolChoice = z.input<typeof AnthropicToolChoiceSchema>

export const AnthropicIncomingRequestSchema = z.object({
  model: z.string().nonempty(),
  // max_tokens is required by the Anthropic Messages API spec.
  max_tokens: z.number().int().positive(),
  temperature: z.number().optional(),
  stream: z.boolean().default(false),
  system: z.union([z.string().nonempty(), z.array(AnthropicSystemBlockSchema)]).optional(),
  messages: z.array(AnthropicIncomingMessageSchema).default([]),
  tools: z.array(AnthropicToolDefSchema).default([]),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  thinking: z
    .object({
      // type is the discriminator (`enabled` for explicit extended
      // thinking; other values like `adaptive` exist server-side).
      // budget_tokens is the ceiling and is mandatory specifically
      // when type === 'enabled' — Anthropic rejects an enabled
      // request without it. Other types may omit it, so the refine
      // below scopes the requirement to the enabled case rather than
      // making the field globally required.
      type: z.string().nonempty(),
      budget_tokens: z.number().int().nonnegative().optional()
    })
    .refine((t) => t.type !== 'enabled' || typeof t.budget_tokens === 'number', {
      message: 'thinking.budget_tokens is required when thinking.type is "enabled"',
      path: ['budget_tokens']
    })
    .optional(),
  // Claude Code extension fields observed in captured traffic.
  // Typed loosely — internal shapes may evolve without notice.
  metadata: z.record(z.string(), z.unknown()).optional(),
  context_management: z.record(z.string(), z.unknown()).optional(),
  output_config: z.record(z.string(), z.unknown()).optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional()
})
export type AnthropicIncomingRequest = z.input<typeof AnthropicIncomingRequestSchema>

// ─── Anthropic incoming request headers ────────────────────────────────
// Headers that Claude Code (or any compliant client) must send to Rialto's
// /v1/messages endpoint. Validated against the captured fixture corpus in
// fixture-schemas.test.ts so a breaking change to the expected header set
// surfaces as a test failure rather than a runtime surprise.

export const AnthropicIncomingRequestHeadersSchema = z
  .object({
    // Required by the Anthropic Messages API spec.
    'anthropic-version': z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'anthropic-version must be YYYY-MM-DD'),
    // Exactly one of these auth headers must be present.
    'x-api-key': z.string().min(1).optional(),
    authorization: z.string().min(1).optional(),
    // Standard MIME type — optional but always sent by Claude Code.
    'content-type': z.string().optional(),
    // Comma-separated beta feature flags e.g. "interleaved-thinking-2025-05-14".
    'anthropic-beta': z.string().optional()
  })
  .passthrough()
  .refine((h) => h['x-api-key'] !== undefined || h['authorization'] !== undefined, {
    message: 'Request must carry either x-api-key or authorization header'
  })

export type AnthropicIncomingRequestHeaders = z.input<typeof AnthropicIncomingRequestHeadersSchema>

/**
 * Tokenizer-side schemas.
 *
 * `ProviderTokenizerConfig` configures the TokenizerRegistry (currently
 * the pipeline only uses the cl100k_base fallback, but the shape sets
 * up future per-provider tokenizer customisation).
 *
 * The `Tokenize*` family describes the structured request a Tokenizer
 * `countTokens()` receives — the Anthropic-shaped envelope of
 * messages / system / tools that the router hands off.
 */

import { z } from '@hono/zod-openapi'

// ─── TokenizerRegistry config ──────────────────────────────────────────

export const ProviderTokenizerConfigSchema = z.object({
  type: z.enum(['tiktoken', 'huggingface', 'api']).optional(),
  /** Model id used by the tokenizer (encoding for tiktoken, repo for HF). */
  model: z.string().nonempty().optional(),
  /** Remote endpoint, for the api-tokenizer backend. */
  endpoint: z.string().nonempty().optional(),
  apiKey: z.string().nonempty().optional()
})
export type ProviderTokenizerConfig = z.infer<typeof ProviderTokenizerConfigSchema>

// ─── Tokenize request envelope ─────────────────────────────────────────

/**
 * A single content block inside a structured user/assistant message.
 * The Anthropic wire format mixes text / tool calls / tool results;
 * tokenizers only peek at the discriminator and the few fields each
 * branch carries.
 */
export const TokenizeTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(0)
})

export const TokenizeToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  input: z.unknown()
})

export const TokenizeToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  content: z.union([z.string().min(0), z.unknown()])
})

/** Open-ended fallback for content blocks with a custom `type` string —
 *  vendor SDKs add new block kinds (image, audio, …) and the tokenizer
 *  silently ignores anything it doesn't recognise. */
export const TokenizeUnknownBlockSchema = z.object({ type: z.string().nonempty() }).catchall(z.unknown())

export const TokenizeContentBlockSchema = z.union([
  TokenizeTextBlockSchema,
  TokenizeToolUseBlockSchema,
  TokenizeToolResultBlockSchema,
  TokenizeUnknownBlockSchema
])
export type TokenizeContentBlock = z.infer<typeof TokenizeContentBlockSchema>

export const TokenizeMessageSchema = z.object({
  role: z.string().nonempty(),
  content: z.union([z.string().min(0), z.array(TokenizeContentBlockSchema)])
})
export type TokenizeMessage = z.infer<typeof TokenizeMessageSchema>

export const TokenizeSystemBlockSchema = z.object({
  type: z.string().nonempty(),
  // Anthropic packs system content either as a single string per block
  // or as a string[] (rare); both shapes flow through unchanged.
  text: z.union([z.string().min(0), z.array(z.string().min(0))]).optional()
})

export const TokenizeSystemSchema = z.union([z.string().min(0), z.array(TokenizeSystemBlockSchema)])
export type TokenizeSystem = z.infer<typeof TokenizeSystemSchema>

export const TokenizeToolSchema = z.object({
  name: z.string().nonempty(),
  description: z.string().nonempty().optional(),
  // Tools carry an arbitrary JSON-schema-shaped object the tokenizer
  // serialises and counts; not modelled further here.
  input_schema: z.record(z.string().nonempty(), z.unknown())
})
export type TokenizeTool = z.infer<typeof TokenizeToolSchema>

export const TokenizeRequestSchema = z.object({
  messages: z.array(TokenizeMessageSchema),
  system: TokenizeSystemSchema.optional(),
  tools: z.array(TokenizeToolSchema).default([])
})
export type TokenizeRequest = z.input<typeof TokenizeRequestSchema>

/**
 * OpenAI chat-completions wire shapes: the non-stream response envelope
 * and the `chat.completion.chunk` stream envelope.
 *
 * Both sit in wire/ because they are OpenAI's format, not ours — but
 * note the chunk shape is also what the Gemini transformer *emits*
 * internally, since the pipeline standardised on OpenAI-shaped chunks
 * before it standardised on anything else.
 */

import { z } from '@hono/zod-openapi'
// The delta carries unified annotations verbatim — OpenAI's own
// annotation shape is on the Responses surface, not on chunks.
import { AnnotationSchema } from '@/schemas/domain/unified'

// ─── OpenAI chat.completion RESPONSE envelope ──────────────────────────
//
// The non-stream shape every OpenAI-compat chat endpoint returns. Read
// by the Responses-inbound reverse converter.

export const ChatCompletionResponseToolCallSchema = z
  .object({
    id: z.string().nonempty().optional(),
    type: z.string().nonempty().optional(),
    // Not OpenAI's: the unified tool call's namespace, which a chat
    // completion assembled from a Responses upstream carries for the
    // Responses inbound converter to hand back (see UnifiedToolCallSchema).
    // Loose so that an empty one cannot fail the whole completion's parse.
    namespace: z.string().min(0).nullish(),
    function: z
      .object({
        name: z.string().min(0).optional(),
        arguments: z.string().min(0).optional()
      })
      .loose()
      .optional()
  })
  .loose()
export type ChatCompletionResponseToolCall = z.infer<typeof ChatCompletionResponseToolCallSchema>

export const ChatCompletionResponseMessageSchema = z
  .object({
    role: z.string().nonempty().optional(),
    content: z.unknown().optional(),
    tool_calls: z.array(ChatCompletionResponseToolCallSchema).optional()
  })
  .loose()
export type ChatCompletionResponseMessage = z.infer<typeof ChatCompletionResponseMessageSchema>

export const ChatCompletionResponseChoiceSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    message: ChatCompletionResponseMessageSchema.optional(),
    finish_reason: z.union([z.string().nonempty(), z.null()]).optional()
  })
  .loose()
export type ChatCompletionResponseChoice = z.infer<typeof ChatCompletionResponseChoiceSchema>

export const ChatCompletionResponseSchema = z
  .object({
    id: z.string().nonempty().optional(),
    object: z.string().nonempty().optional(),
    created: z.number().int().nonnegative().optional(),
    model: z.string().nonempty().optional(),
    choices: z.array(ChatCompletionResponseChoiceSchema).optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional()
      })
      .loose()
      .optional()
  })
  .loose()
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>

// ─── OpenAI-shaped pipeline output (chat.completion.chunk) ─────────────
//
// gemini-response converts Gemini wire chunks into these OpenAI-shaped
// envelopes for the rest of the pipeline (anthropic transformer reads
// them as if they came from a chat-completions endpoint).

export const PipelineToolCallSchema = z.object({
  id: z.string().nonempty(),
  type: z.literal('function'),
  function: z.object({
    name: z.string().nonempty().optional(),
    arguments: z.string().min(0)
  })
})
export type PipelineToolCall = z.input<typeof PipelineToolCallSchema>

export const PipelineToolCallDeltaSchema = PipelineToolCallSchema.extend({
  index: z.number().int().nonnegative()
})
export type PipelineToolCallDelta = z.input<typeof PipelineToolCallDeltaSchema>

export const PipelineDeltaSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string().min(0), z.null()]).optional(),
  thinking: z
    .object({
      content: z.string().min(0).optional(),
      signature: z.string().nonempty().optional()
    })
    .optional(),
  tool_calls: z.array(PipelineToolCallDeltaSchema).default([]),
  annotations: z.array(AnnotationSchema).default([])
})
export type PipelineDelta = z.input<typeof PipelineDeltaSchema>

export const PipelineChunkChoiceSchema = z.object({
  delta: PipelineDeltaSchema,
  finish_reason: z.union([z.string().nonempty(), z.null()]),
  index: z.number().int().nonnegative(),
  logprobs: z.null()
})
export type PipelineChunkChoice = z.input<typeof PipelineChunkChoiceSchema>

export const PipelineChunkUsageSchema = z.object({
  completion_tokens: z.number().int().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }),
  total_tokens: z.number().int().nonnegative(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative() })
})
export type PipelineChunkUsage = z.input<typeof PipelineChunkUsageSchema>

export const PipelineStreamChunkSchema = z.object({
  choices: z.array(PipelineChunkChoiceSchema),
  // Unix epoch seconds (OpenAI uses seconds; Gemini conversion emits seconds).
  created: z.number().int().nonnegative(),
  id: z.string().nonempty(),
  model: z.string().nonempty(),
  object: z.literal('chat.completion.chunk'),
  system_fingerprint: z.string().nonempty(),
  usage: PipelineChunkUsageSchema.optional()
})
export type PipelineStreamChunk = z.input<typeof PipelineStreamChunkSchema>

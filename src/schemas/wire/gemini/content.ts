/**
 * Zod schemas for the Gemini wire formats consumed/produced by the
 * Gemini transformer's request/response conversion helpers.
 *
 * These describe the subset of the Gemini `generateContent` /
 * `streamGenerateContent` JSON shapes we actually read. They exist so
 * the gemini-conversion helpers can `safeParse` an inbound payload once
 * and pass typed structures to the rest of the conversion code instead
 * of sprinkling `as` assertions over `unknown` fields.
 */

import { z } from '@hono/zod-openapi'
import { AnnotationSchema, ThinkLevelSchema } from '@/schemas/domain/unified'

// ─── Gemini response sub-shapes ────────────────────────────────────────

// Token-count fields default to `0` so callers can treat missing values
// the same as zero — that matches the OpenAI-shaped usage block we
// emit, where each field is a required number.
export const GeminiUsageMetadataSchema = z
  .object({
    candidatesTokenCount: z.number().int().nonnegative().default(0),
    promptTokenCount: z.number().int().nonnegative().default(0),
    cachedContentTokenCount: z.number().int().nonnegative().default(0),
    totalTokenCount: z.number().int().nonnegative().default(0),
    thoughtsTokenCount: z.number().int().nonnegative().default(0)
  })
  .loose()
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>

// Inner `segment` defaults to an empty record (with default-filled
// fields) so callers can access `.text` / `.startIndex` directly.
const GeminiSegmentSchema = z
  .object({
    text: z.string().default(''),
    startIndex: z.number().int().nonnegative().default(0),
    endIndex: z.number().int().nonnegative().default(0)
  })
  .loose()

export const GeminiGroundingSupportSchema = z
  .object({
    groundingChunkIndices: z.array(z.number().int().nonnegative()).default([]),
    segment: GeminiSegmentSchema.default({ text: '', startIndex: 0, endIndex: 0 })
  })
  .loose()
export type GeminiGroundingSupport = z.infer<typeof GeminiGroundingSupportSchema>

const GeminiWebSchema = z
  .object({
    uri: z.string().default(''),
    title: z.string().default('')
  })
  .loose()

export const GeminiGroundingChunkSchema = z
  .object({
    web: GeminiWebSchema.default({ uri: '', title: '' })
  })
  .loose()
export type GeminiGroundingChunk = z.infer<typeof GeminiGroundingChunkSchema>

export const GeminiGroundingMetadataSchema = z
  .object({
    groundingChunks: z.array(GeminiGroundingChunkSchema).default([]),
    groundingSupports: z.array(GeminiGroundingSupportSchema).default([])
  })
  .loose()
export type GeminiGroundingMetadata = z.infer<typeof GeminiGroundingMetadataSchema>

// ─── Gemini Part / Content ─────────────────────────────────────────────

// `text` defaults to '' so callers can read `.text` directly. `thought`
// defaults to false (Gemini omits the field for non-reasoning parts).
export const GeminiResponsePartSchema = z
  .object({
    text: z.string().default(''),
    thought: z.boolean().default(false),
    thoughtSignature: z.string().nonempty().optional(),
    functionCall: z
      .object({
        id: z.string().nonempty().optional(),
        name: z.string().nonempty().optional(),
        args: z.record(z.string().nonempty(), z.unknown()).default({})
      })
      .loose()
      .optional()
  })
  .loose()
export type GeminiResponsePart = z.infer<typeof GeminiResponsePartSchema>

export const GeminiCandidateSchema = z
  .object({
    content: z
      .object({
        parts: z.array(GeminiResponsePartSchema).default([])
      })
      .loose()
      .optional(),
    finishReason: z.string().nonempty().optional(),
    groundingMetadata: GeminiGroundingMetadataSchema.optional()
  })
  .loose()
export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>

// ─── Gemini blocking response / streaming chunk ────────────────────────

export const GeminiResponseSchema = z
  .object({
    candidates: z.array(GeminiCandidateSchema),
    // Gemini emits `responseId` for every response but it's officially
    // optional on the wire — fall back to '' so the OpenAI-shaped `id`
    // is always a string.
    responseId: z.string().default(''),
    modelVersion: z.string().nonempty().optional(),
    usageMetadata: GeminiUsageMetadataSchema.optional()
  })
  .loose()
export type GeminiResponse = z.infer<typeof GeminiResponseSchema>

export const GeminiStreamChunkSchema = GeminiResponseSchema.extend({
  modelVersion: z.string().nonempty()
})
export type GeminiStreamChunk = z.infer<typeof GeminiStreamChunkSchema>

// ─── Inbound Gemini-shaped request (for transformRequestOut) ───────────

// Google's JSON mapping accepts both the camelCase names its SDKs emit
// and the snake_case proto names, and our own outbound builders emit a
// mix of the two. Every inbound alias is therefore declared here and
// collapsed by the conversion helper rather than guessed at call sites.
const GeminiInboundBlobSchema = z
  .object({
    mimeType: z.string().nonempty().optional(),
    mime_type: z.string().nonempty().optional(),
    data: z.string().nonempty().optional()
  })
  .loose()

const GeminiInboundFileRefSchema = z
  .object({
    mimeType: z.string().nonempty().optional(),
    mime_type: z.string().nonempty().optional(),
    fileUri: z.string().nonempty().optional(),
    file_uri: z.string().nonempty().optional()
  })
  .loose()

const GeminiInboundFunctionCallSchema = z
  .object({
    id: z.string().nonempty().optional(),
    name: z.string().nonempty().optional(),
    args: z.record(z.string().nonempty(), z.unknown()).default({})
  })
  .loose()

// `response` stays `unknown`: Gemini lets the client put any JSON under
// it, and the conversion helper has to stringify whatever it finds.
const GeminiInboundFunctionResponseSchema = z
  .object({
    id: z.string().nonempty().optional(),
    name: z.string().nonempty().optional(),
    response: z.unknown().optional()
  })
  .loose()
export type GeminiInboundFunctionResponse = z.infer<typeof GeminiInboundFunctionResponseSchema>

// `text` is deliberately NOT defaulted. A default made every part look
// like a text part, which is what let `inboundContentToMessage` short
// out before it ever reached the image / functionCall branches — the
// whole gemini column of the inbound parity matrix hung off it.
// `.min(0)` keeps the empty string legal (Gemini emits `text: ''` for a
// contentless part) while still declaring that intent explicitly.
const GeminiInboundPartSchema = z
  .object({
    text: z.string().min(0).optional(),
    thought: z.boolean().default(false),
    thoughtSignature: z.string().nonempty().optional(),
    inlineData: GeminiInboundBlobSchema.optional(),
    inline_data: GeminiInboundBlobSchema.optional(),
    fileData: GeminiInboundFileRefSchema.optional(),
    file_data: GeminiInboundFileRefSchema.optional(),
    functionCall: GeminiInboundFunctionCallSchema.optional(),
    functionResponse: GeminiInboundFunctionResponseSchema.optional()
  })
  .loose()
export type GeminiInboundPart = z.infer<typeof GeminiInboundPartSchema>

const GeminiInboundContentObjectSchema = z
  .object({
    role: z.string().nonempty().optional(),
    parts: z.array(GeminiInboundPartSchema).default([]),
    // Legacy `{ text: '…' }` content object. Gemini's own SDKs never
    // send it, but it was the only shape this converter understood
    // before parts[] worked, so it is still accepted — undefaulted, for
    // the same reason as the part-level `text`.
    text: z.string().min(0).optional()
  })
  .loose()

const GeminiInboundContentSchema = z.union([z.string().nonempty(), GeminiInboundContentObjectSchema])
export type GeminiInboundContent = z.infer<typeof GeminiInboundContentSchema>

const GeminiInboundFunctionDeclarationSchema = z
  .object({
    name: z.string().default(''),
    description: z.string().default(''),
    parameters: z.unknown().optional()
  })
  .loose()

const GeminiInboundToolSchema = z
  .object({
    functionDeclarations: z.array(GeminiInboundFunctionDeclarationSchema).default([])
  })
  .loose()
export type GeminiInboundTool = z.infer<typeof GeminiInboundToolSchema>

// `thinkingLevel` / `mode` are read as free strings rather than enums on
// purpose: Google adds values to both (`VALIDATED`, new think levels)
// faster than we ship, and a strict enum here would turn an unknown
// value into a 500 for the whole request instead of one ignored field.
const GeminiInboundThinkingConfigSchema = z
  .object({
    includeThoughts: z.boolean().default(false),
    thinkingLevel: z.string().nonempty().optional(),
    thinkingBudget: z.number().int().optional()
  })
  .loose()
export type GeminiInboundThinkingConfig = z.infer<typeof GeminiInboundThinkingConfigSchema>

const GeminiInboundGenerationConfigSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    thinkingConfig: GeminiInboundThinkingConfigSchema.optional()
  })
  .loose()
export type GeminiInboundGenerationConfig = z.infer<typeof GeminiInboundGenerationConfigSchema>

const GeminiInboundFunctionCallingConfigSchema = z
  .object({
    mode: z.string().nonempty().optional(),
    allowedFunctionNames: z.array(z.string().nonempty()).default([])
  })
  .loose()

const GeminiInboundToolConfigSchema = z
  .object({
    functionCallingConfig: GeminiInboundFunctionCallingConfigSchema.optional()
  })
  .loose()
export type GeminiInboundToolConfig = z.infer<typeof GeminiInboundToolConfigSchema>

export const GeminiInboundRequestSchema = z
  .object({
    contents: z.array(GeminiInboundContentSchema).default([]),
    // Gemini carries the system prompt beside `contents`, not inside it.
    systemInstruction: GeminiInboundContentSchema.optional(),
    system_instruction: GeminiInboundContentSchema.optional(),
    tools: z.array(GeminiInboundToolSchema).default([]),
    toolConfig: GeminiInboundToolConfigSchema.optional(),
    generationConfig: GeminiInboundGenerationConfigSchema.optional(),
    generation_config: GeminiInboundGenerationConfigSchema.optional(),
    model: z.string().nonempty(),
    // OpenAI-vocabulary siblings of `generationConfig.*`. No Gemini
    // client sends these; they are kept as a fallback because the
    // schema has always accepted them.
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stream: z.boolean().default(false),
    tool_choice: z.unknown().optional()
  })
  .loose()
export type GeminiInboundRequest = z.infer<typeof GeminiInboundRequestSchema>
// ─── Gemini outbound wire shapes (what we emit to Gemini) ──────────────

export const GeminiInlineDataSchema = z.object({
  mime_type: z.string().nonempty(),
  data: z.string().nonempty()
})
export type GeminiInlineData = z.input<typeof GeminiInlineDataSchema>

export const GeminiFileDataSchema = z.object({
  mime_type: z.string().nonempty(),
  file_uri: z.string().nonempty()
})
export type GeminiFileData = z.input<typeof GeminiFileDataSchema>

export const GeminiFunctionCallPartSchema = z.object({
  functionCall: z.object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    args: z.record(z.string().nonempty(), z.unknown())
  }),
  thoughtSignature: z.string().nonempty().optional()
})
export type GeminiFunctionCallPart = z.input<typeof GeminiFunctionCallPartSchema>

export const GeminiFunctionResponsePartSchema = z.object({
  functionResponse: z.object({
    name: z.string().nonempty().optional(),
    response: z.object({ result: z.union([z.string().min(0), z.unknown()]) })
  })
})
export type GeminiFunctionResponsePart = z.input<typeof GeminiFunctionResponsePartSchema>

export const GeminiTextPartSchema = z.object({
  text: z.string().min(0),
  thoughtSignature: z.string().nonempty().optional()
})
export type GeminiTextPart = z.input<typeof GeminiTextPartSchema>

export const GeminiInlineDataPartSchema = z.object({ inlineData: GeminiInlineDataSchema })
export type GeminiInlineDataPart = z.input<typeof GeminiInlineDataPartSchema>

export const GeminiFileDataPartSchema = z.object({ file_data: GeminiFileDataSchema })
export type GeminiFileDataPart = z.input<typeof GeminiFileDataPartSchema>

export const GeminiPartSchema = z.union([
  GeminiTextPartSchema,
  GeminiInlineDataPartSchema,
  GeminiFileDataPartSchema,
  GeminiFunctionCallPartSchema,
  GeminiFunctionResponsePartSchema
])
export type GeminiPart = z.input<typeof GeminiPartSchema>

export const GeminiContentSchema = z.object({
  role: z.enum(['user', 'model']),
  parts: z.array(GeminiPartSchema)
})
export type GeminiContent = z.input<typeof GeminiContentSchema>

export const GeminiThinkingConfigSchema = z.object({
  includeThoughts: z.boolean(),
  thinkingLevel: ThinkLevelSchema.optional(),
  thinkingBudget: z.number().int().nonnegative().optional()
})
export type GeminiThinkingConfig = z.input<typeof GeminiThinkingConfigSchema>

export const GeminiGenerationConfigSchema = z.object({
  thinkingConfig: GeminiThinkingConfigSchema.optional()
})
export type GeminiGenerationConfig = z.input<typeof GeminiGenerationConfigSchema>

export const GeminiFunctionCallingConfigSchema = z.object({
  mode: z.enum(['auto', 'none', 'any']).optional(),
  allowedFunctionNames: z.array(z.string().nonempty()).default([])
})
export type GeminiFunctionCallingConfig = z.input<typeof GeminiFunctionCallingConfigSchema>

export const GeminiToolConfigSchema = z.object({
  functionCallingConfig: GeminiFunctionCallingConfigSchema
})
export type GeminiToolConfig = z.input<typeof GeminiToolConfigSchema>

// ─── Gemini outbound request body (what we POST upstream) ──────────────
//
// Imported here from `./llm-gemini-schema-tools` would be cleaner, but
// the `GeminiTool` schema lives inside the conversion utility right now.
// Until that moves into this file, GeminiRequestBody stays as the
// plain type alias re-exported from gemini-request.ts. (The tool schema
// is a recursive structure that the conversion helper builds manually.)

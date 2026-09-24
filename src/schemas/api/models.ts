// The model refresh, model test and per-model PATCH endpoints.

import { z } from '@hono/zod-openapi'

export const RefreshOutcomeSchema = z
  .object({
    provider: z.string().nonempty(),
    added: z.array(z.string().nonempty()),
    error: z.string().optional()
  })
  .openapi('RefreshOutcome')

export const RefreshModelsResponseSchema = z
  .object({
    outcomes: z.array(RefreshOutcomeSchema)
  })
  .openapi('RefreshModelsResponse')

export const ModelTestRequestSchema = z
  .object({
    provider: z.string().nonempty(),
    model: z.string().nonempty()
  })
  .openapi('ModelTestRequest')

export const ModelTestResultSchema = z
  .object({
    provider: z.string().nonempty(),
    model: z.string().nonempty(),
    status: z.enum(['ok', 'fail']),
    error: z.string().optional(),
    latencyMs: z.number().int().nonnegative()
  })
  .openapi('ModelTestResult')

export const ModelTestAllRequestSchema = z
  .object({
    scope: z.enum(['all', 'failing'])
  })
  .openapi('ModelTestAllRequest')

export const ModelTestAllResponseSchema = z
  .object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    results: z.array(ModelTestResultSchema)
  })
  .openapi('ModelTestAllResponse')

// PATCH /api/providers/:name/models/:model. Every field is optional
// so the caller can send just the slice it wants to change. `enabled`
// stays required-shaped for back-compat; the route handler treats
// missing fields as "no change".
export const UpdateModelBodySchema = z.object({
  enabled: z.boolean().optional(),
  // Manual reasoning-effort override for OpenAI / OpenAI-Responses /
  // Codex models. null clears the override (vendor default = medium);
  // omit to leave the current value untouched. Enum mirrors the values
  // the OpenAI OpenAPI spec accepts — not every reasoning model supports
  // every value, but the transformer passes through and 400s surface as
  // upstream errors, not schema violations.
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable().optional()
})

export const ReasoningEffortSchema = z
  .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  .openapi('ReasoningEffort')
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>

export const UpdateModelSuccessResponseSchema = z
  .object({ success: z.literal(true) })
  .openapi('UpdateModelSuccessResponse')

export const UpdateModelErrorResponseSchema = z
  .object({ success: z.literal(false), error: z.string().nonempty() })
  .openapi('UpdateModelErrorResponse')

// Vendor /v1/models response shapes. OpenAI-compatible returns
// `{ data: [{ id }] }`; Google Gemini returns `{ models: [{ name }] }`.
// We accept either and pluck only the identifier — anything else
// (description, capabilities, …) is ignored.
export const VendorModelsResponseSchema = z
  .object({
    // OpenAI shape. `context_window` is not part of OpenAI's own catalog
    // response, but several OpenAI-compatible vendors add it, and reading
    // it costs nothing when it is absent.
    data: z
      .array(
        z.object({
          id: z.string().nonempty().optional(),
          context_window: z.number().int().positive().optional(),
          // Anthropic's Models API spelling of the same figure. Its docs
          // name `max_input_tokens` and `max_tokens` on every entry, and
          // the comparison table on the docs site only covers the current
          // four models — so this is the only per-model source for the
          // rest of the lineup.
          max_input_tokens: z.number().int().positive().optional()
        })
      )
      .optional(),
    // Google shape. `inputTokenLimit` is the context window, published
    // per model — the only first-party source for it, since the pricing
    // page carries it for a handful of models at most.
    models: z
      .array(
        z.object({
          name: z.string().nonempty().optional(),
          inputTokenLimit: z.number().int().positive().optional()
        })
      )
      .optional()
  })
  .loose()

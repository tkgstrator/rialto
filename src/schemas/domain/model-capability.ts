/**
 * What a subscription model accepts, read once per model (the
 * ModelCapability table) and carried on both provider projections: the
 * one the UI reads (domain/provider.ts) and the one the pipeline reads
 * (domain/pipeline.ts).
 */

import { z } from '@hono/zod-openapi'

export const SupportedEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export type SupportedEffort = z.infer<typeof SupportedEffortSchema>

// An effort as a `thinking` probe sent it: a named level, or 'default' for
// a request that sent none, which the model resolves on its own and so is
// a separate question from every named level.
export const ThinkingEffortKeySchema = z.enum(['default', ...SupportedEffortSchema.options])
export type ThinkingEffortKey = z.infer<typeof ThinkingEffortKeySchema>

// The efforts each way of turning Claude's thinking off was accepted with.
export const ThinkingOffSchema = z.object({
  disabled: z.array(ThinkingEffortKeySchema),
  betweenTools: z.array(ThinkingEffortKeySchema)
})
export type ThinkingOff = z.infer<typeof ThinkingOffSchema>

// Keyed by model name. Only models with a recorded row appear.
export const ModelSupportedEffortsSchema = z.record(z.string().nonempty(), z.array(SupportedEffortSchema))
export const ModelThinkingOffSchema = z.record(z.string().nonempty(), ThinkingOffSchema)

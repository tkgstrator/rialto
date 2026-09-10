/**
 * Request and response envelopes for the /api/providers routes. The
 * provider payload itself is the domain shape; only the envelopes
 * around it (success flags, warnings, error bodies) are api-layer.
 */

import { z } from '@hono/zod-openapi'
import { ProviderSchema } from '@/schemas/domain/provider'

export const ProviderTestRequestSchema = z
  .object({
    name: z.string().nonempty()
  })
  .openapi('ProviderTestRequest')

export const ProviderTestResponseSchema = z
  .object({
    success: z.boolean(),
    latencyMs: z.number().int().nonnegative().optional(),
    error: z.string().nonempty().optional()
  })
  .openapi('ProviderTestResponse')

// GET /api/providers — flat array of every provider row.
export const ProviderListResponseSchema = z.array(ProviderSchema).openapi('ProviderListResponse')

// Wire shape returned by POST/PATCH /api/providers and
// PATCH /api/providers/:name. Carries the round-tripped Provider plus
// any non-fatal warnings the apply layer produced (e.g. chain entries
// the cascade removed because a model they named was dropped).
export const ProviderUpsertResponseSchema = z
  .object({
    success: z.literal(true),
    provider: ProviderSchema,
    warnings: z.array(z.string().nonempty()).optional()
  })
  .openapi('ProviderUpsertResponse')

// Same `warnings` convention: deleting a provider cascades to every
// chain entry naming one of its models, and the count is reported here
// rather than silently swallowed.
export const ProviderDeleteResponseSchema = z
  .object({
    success: z.literal(true),
    warnings: z.array(z.string().nonempty()).optional()
  })
  .openapi('ProviderDeleteResponse')

// 404 / 5xx error envelope used by the providers + provider/model
// CRUD endpoints when the resource was not found or the underlying
// service threw. ZodError validation failures use the separate
// ValidationErrorResponseSchema in src/api/zod-response.ts.
export const ProviderErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string().nonempty()
  })
  .openapi('ProviderErrorResponse')

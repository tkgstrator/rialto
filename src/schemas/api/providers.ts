/**
 * Request and response envelopes for the /api/providers routes. The
 * provider payload itself is the domain shape; only the envelopes
 * around it (success flags, warnings, error bodies) are api-layer.
 */

import { z } from '@hono/zod-openapi'
import { ProviderSchema } from '@/schemas/domain/provider'
import { CUSTOM_API_STYLES, customNameProblem, parseCustomBaseUrl } from '@/shared/custom-provider'

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
// any non-fatal warnings the apply layer produced (e.g. a model API
// style naming a model the provider no longer lists).
export const ProviderUpsertResponseSchema = z
  .object({
    success: z.literal(true),
    provider: ProviderSchema,
    warnings: z.array(z.string().nonempty()).optional()
  })
  .openapi('ProviderUpsertResponse')

export const ProviderDeleteResponseSchema = z
  .object({
    success: z.literal(true)
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

// POST /api/providers/custom — the Custom provider of the Connect flow.
//
// Not a second provider shape: the body names only what the operator typed,
// and the route turns it into the ordinary Provider row (`api_base_url`,
// `api_key`, `api_style`). Name and Base URL rules are the shared ones the
// form checks while typing, so the server refuses exactly what the form
// already warned about; the issue `message` is the problem code the form
// maps to its own wording.
export const CustomProviderCreateRequestSchema = z
  .object({
    name: z.string().nonempty(),
    base_url: z.string().nonempty(),
    // Required: the request pipeline skips a provider with no key, so a
    // keyless one could never be served. A local server that checks no key
    // takes any placeholder.
    api_key: z.string().trim().nonempty(),
    api_style: z.enum(CUSTOM_API_STYLES)
  })
  .superRefine((body, ctx) => {
    const problem = customNameProblem(body.name)
    if (problem !== null) ctx.addIssue({ code: 'custom', path: ['name'], message: problem })
    if (parseCustomBaseUrl(body.base_url) === null) {
      ctx.addIssue({ code: 'custom', path: ['base_url'], message: 'invalid_base_url' })
    }
  })
  .openapi('CustomProviderCreateRequest')

// How the one-shot model lookup at connect time went. A failure is a normal
// outcome, not an error: the provider exists either way, and the operator
// adds model ids by hand.
export const CustomModelsLookupSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('found'), count: z.number().int().positive() }),
    z.object({ status: z.literal('unavailable'), error: z.string().nonempty() })
  ])
  .openapi('CustomModelsLookup')

export const CustomProviderCreateResponseSchema = z
  .object({
    success: z.literal(true),
    provider: ProviderSchema,
    models: CustomModelsLookupSchema,
    // Always present, empty when there is nothing to say: an optional array
    // would be two ways to spell "no warnings".
    warnings: z.array(z.string().nonempty())
  })
  .openapi('CustomProviderCreateResponse')

export type CustomModelsLookup = z.infer<typeof CustomModelsLookupSchema>
export type CustomProviderCreateResponse = z.infer<typeof CustomProviderCreateResponseSchema>

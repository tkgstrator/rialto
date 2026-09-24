/**
 * The tier map: what routing reads instead of the per-scenario chain.
 *
 * A profile maps each requested tier — read off the model name the caller
 * sent — to an ordered list of routes, and each route names a provider and
 * a tier on it. Which model that is, is the provider's tier alias. Nothing
 * here names a model, which is the point: a vendor's new Sonnet moves one
 * alias, not every route that meant "sonnet".
 *
 * Stored shapes only. The read DTOs the API serves (with each route's
 * resolved model and state) and `.openapi()` registration live in the api
 * layer (`schemas/api/routing.ts`).
 */

import { z } from '@hono/zod-openapi'
import { REQUESTED_MODEL_TIERS } from './router'

// The four Claude families, most capable first — the tiers a provider's
// models can be aliased as. Shared with the tier inference that reads a
// requested model name (`tierOf`), so the two cannot disagree on the set.
export const ModelTierSchema = z.enum(REQUESTED_MODEL_TIERS)
export type ModelTier = z.infer<typeof ModelTierSchema>

// What a request can be classified as: one of the four, or "other" when
// its model name says no Claude family (gpt-*, gemini-*, a custom id).
export const ROUTE_TIERS = [...REQUESTED_MODEL_TIERS, 'other'] as const
export const RouteTierSchema = z.enum(ROUTE_TIERS)
export type RouteTier = z.infer<typeof RouteTierSchema>

// One route: serve with this provider's `targetTier` model. `enabled` is a
// soft toggle that keeps the route's place in the order.
export const TierRouteSchema = z.object({
  provider: z.string().nonempty(),
  targetTier: ModelTierSchema,
  enabled: z.boolean().default(true)
})
export type TierRoute = z.infer<typeof TierRouteSchema>

// Every requested tier is present, empty when it has no routes, so a
// reader never branches on a missing key. Order within a list is
// preference, first to last.
export const TierRoutesSchema = z.object({
  fable: z.array(TierRouteSchema).default([]),
  opus: z.array(TierRouteSchema).default([]),
  sonnet: z.array(TierRouteSchema).default([]),
  haiku: z.array(TierRouteSchema).default([]),
  other: z.array(TierRouteSchema).default([])
})
export type TierRoutes = z.infer<typeof TierRoutesSchema>

/**
 * The knobs the tier map keeps from the chain's constraints.
 *
 * Tier substitution is gone — substituting a tier is a route now, written
 * where a reader can see it — and so are the scheduler's scoring and pace
 * knobs, which had no effect on the request path beyond a zero weight.
 * These four do: what to answer when every route of a tier is out of
 * quota, and the two health gates. Stored in the same JSONB column as
 * before, so a blob that still carries retired keys parses; they are
 * ignored, not rejected.
 */
export const RoutingConstraintsSchema = z.object({
  // Every route of the tier gated by quota or health: answer 429 with
  // Retry-After, or send the request upstream on the caller's own model.
  exhaustedBehavior: z.enum(['429', 'passthrough']).default('429'),
  // Skip a route whose budget is used at or past this percentage.
  quotaSkipPct: z.number().min(0).max(100).default(100),
  // Skip a route whose 5-minute error rate is at or above this (0-1)…
  errorRateSkipPct: z.number().min(0).max(1).default(0.5),
  // …once it has at least this many recent samples.
  minHealthSamples: z.number().int().min(0).default(5)
})
export type RoutingConstraints = z.infer<typeof RoutingConstraintsSchema>

export const TierProfileSchema = z.object({
  routes: TierRoutesSchema,
  constraints: RoutingConstraintsSchema
})
export type TierProfile = z.infer<typeof TierProfileSchema>

/**
 * Wire shapes for the tier map and the provider tier aliases.
 *
 * The stored shapes are the domain layer's (`schemas/domain/tier-route.ts`);
 * what the API adds is each route's resolution — which model its alias
 * names today and whether that model can take traffic — so the Routing
 * screen can show it without a second request per row.
 */

import { z } from '@hono/zod-openapi'
import { ModelTierSchema, RoutingConstraintsSchema, TierProfileSchema } from '../domain/tier-route'

export const TierRouteResolutionSchema = z
  .object({
    model: z.string().nonempty(),
    // The model and its provider are both switched on.
    targetEnabled: z.boolean(),
    // Can run a request carrying Anthropic's web_search tool.
    hostsWebSearch: z.boolean(),
    contextWindow: z.number().int().positive().nullable()
  })
  .openapi('TierRouteResolution')

export const TierRouteViewSchema = z
  .object({
    provider: z.string().nonempty(),
    targetTier: ModelTierSchema,
    enabled: z.boolean(),
    // Null when the provider has no alias for `targetTier` — the route is
    // kept but skipped until one is set.
    resolved: TierRouteResolutionSchema.nullable()
  })
  .openapi('TierRouteView')

export const TierRouteViewsSchema = z
  .object({
    fable: z.array(TierRouteViewSchema),
    opus: z.array(TierRouteViewSchema),
    sonnet: z.array(TierRouteViewSchema),
    haiku: z.array(TierRouteViewSchema),
    other: z.array(TierRouteViewSchema)
  })
  .openapi('TierRouteViews')

export const TierProfileViewSchema = z
  .object({
    key: z.string().nonempty(),
    routes: TierRouteViewsSchema,
    constraints: RoutingConstraintsSchema
  })
  .openapi('TierProfileView')

export const TierProfileWriteSchema = TierProfileSchema.openapi('TierProfileWrite')

export const TierProfileSummarySchema = z
  .object({
    key: z.string().nonempty(),
    routeCount: z.number().int().nonnegative(),
    updatedAt: z.string().nonempty().nullable(),
    kind: z.enum(['map', 'passthrough'])
  })
  .openapi('TierProfileSummary')

export const SaveOutcomeSchema = z
  .object({ success: z.boolean(), warnings: z.array(z.string().nonempty()) })
  .openapi('TierProfileSaveOutcome')

export const TierAliasCandidateSchema = z
  .object({
    model: z.string().nonempty(),
    enabled: z.boolean(),
    // Appeared after the alias was last set.
    isNew: z.boolean()
  })
  .openapi('TierAliasCandidate')

export const TierAliasSchema = z
  .object({
    provider: z.string().nonempty(),
    tier: ModelTierSchema,
    model: z.string().nonempty().nullable(),
    updatedAt: z.string().nonempty().nullable(),
    candidates: z.array(TierAliasCandidateSchema)
  })
  .openapi('TierAlias')

export const SetTierAliasSchema = z.object({ model: z.string().nonempty() }).openapi('SetTierAlias')

export const RoutingErrorSchema = z.object({ error: z.string().nonempty() }).openapi('RoutingError')

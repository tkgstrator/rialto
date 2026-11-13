/**
 * What routing reads: per scenario and lane, the provider · tier
 * combinations to try, top first.
 *
 * A request is classified into a scenario — long input, thinking on, or
 * neither — and a lane — whether it carries the subagent tag — and walks
 * that list. Each route names a provider and a tier on it; which model
 * that is, is the provider's tier alias. Nothing here names a model, which
 * is the point: a vendor's new Sonnet moves one alias, not every list that
 * meant "sonnet".
 *
 * Stored shapes only. The read DTOs the API serves (with each route's
 * resolved model) and `.openapi()` registration live in the api layer
 * (`schemas/api/routing.ts`).
 */

import { z } from '@hono/zod-openapi'
import { REQUESTED_MODEL_TIERS } from './router'

// The four Claude families, most capable first — the tiers a provider's
// models can be aliased as. Shared with the tier inference that reads a
// model name (`tierOf`), so the two cannot disagree on the set.
export const ModelTierSchema = z.enum(REQUESTED_MODEL_TIERS)
export type ModelTier = z.infer<typeof ModelTierSchema>

// Long input, thinking on, or neither. Image and web search were scenarios
// once; every model worth routing to reads images, and a route that cannot
// run the web search tool is skipped for that request instead.
export const ROUTING_SCENARIOS = ['default', 'think', 'longContext'] as const
export const RoutingScenarioSchema = z.enum(ROUTING_SCENARIOS)
export type RoutingScenario = z.infer<typeof RoutingScenarioSchema>

// Whether the request carried the subagent tag.
export const ROUTING_LANES = ['agent', 'subagent'] as const
export const RoutingLaneSchema = z.enum(ROUTING_LANES)
export type RoutingLane = z.infer<typeof RoutingLaneSchema>

// One route: serve with this provider's `targetTier` model. `enabled` is a
// soft toggle that keeps the route's place in the order.
export const TierRouteSchema = z.object({
  provider: z.string().nonempty(),
  targetTier: ModelTierSchema,
  enabled: z.boolean().default(true)
})
export type TierRoute = z.infer<typeof TierRouteSchema>

// Both lanes are always present, empty when they have no routes, so a
// reader never branches on a missing key. Order is preference.
export const LaneRoutesSchema = z.object({
  agent: z.array(TierRouteSchema).default([]),
  subagent: z.array(TierRouteSchema).default([])
})
export type LaneRoutes = z.infer<typeof LaneRoutesSchema>

const EMPTY_LANES = { agent: [], subagent: [] }

export const ScenarioRoutesSchema = z.object({
  default: LaneRoutesSchema.default(EMPTY_LANES),
  think: LaneRoutesSchema.default(EMPTY_LANES),
  longContext: LaneRoutesSchema.default(EMPTY_LANES)
})
export type ScenarioRoutes = z.infer<typeof ScenarioRoutesSchema>

/**
 * The knobs a profile carries, in the same JSONB column the chain used, so
 * a blob that still carries retired keys parses; they are ignored, not
 * rejected.
 *
 * The route gates apply before pace ordering. The Long context threshold is not an
 * operator setting any more: the routing scheduler tunes it (see
 * `routing-scheduler/threshold-tuner.ts`), and these fields are its state.
 */
export const RoutingConstraintsSchema = z.object({
  // Only upward moves into these tiers are forbidden; demotions stay eligible.
  blockedEscalationTiers: z.array(ModelTierSchema).default([]),
  // Every route of the list gated by quota or health: answer 429 with
  // Retry-After, or send the request upstream on the caller's own model.
  exhaustedBehavior: z.enum(['429', 'passthrough']).default('429'),
  // Skip a route whose budget is used at or past this percentage.
  quotaSkipPct: z.number().min(0).max(100).default(100),
  // Skip a route whose 5-minute error rate is at or above this (0-1)…
  errorRateSkipPct: z.number().min(0).max(1).default(0.5),
  // …once it has at least this many recent samples.
  minHealthSamples: z.number().int().min(0).default(5),
  // Input tokens over which a request is Long context. Null means the
  // automatic base: 70% of the context window of the first default · agent
  // route's model. The tuner moves it within [30k, base].
  longContextThreshold: z.number().int().positive().nullable().default(null),
  // The value before the tuner's last change, for the rollback when the
  // Long context route runs out right after a lowering.
  previousLongContextThreshold: z.number().int().positive().nullable().default(null),
  // ISO time of the tuner's last change; it moves at most once a day.
  longContextTunedAt: z.string().nonempty().nullable().default(null),
  // Kill switch for the tuner. Not on the screen.
  autoTuneLongContext: z.boolean().default(true)
})
export type RoutingConstraints = z.infer<typeof RoutingConstraintsSchema>

export const TierProfileSchema = z.object({
  routes: ScenarioRoutesSchema,
  constraints: RoutingConstraintsSchema
})
export type TierProfile = z.infer<typeof TierProfileSchema>

// What a save may carry. A knob the body leaves out (null) keeps its stored
// value, where the defaulted read schema would quietly reset it — a caller
// that omitted autoTuneLongContext would switch the tuner back on. The
// tuner's own state is not writable at all; unknown keys are dropped.
export const RoutingConstraintsWriteSchema = z.object({
  // Null means preserve the stored selection; [] explicitly clears it.
  blockedEscalationTiers: z.array(ModelTierSchema).nullable().default(null),
  exhaustedBehavior: z.enum(['429', 'passthrough']).nullable().default(null),
  quotaSkipPct: z.number().min(0).max(100).nullable().default(null),
  errorRateSkipPct: z.number().min(0).max(1).nullable().default(null),
  minHealthSamples: z.number().int().min(0).nullable().default(null),
  autoTuneLongContext: z.boolean().nullable().default(null)
})

export const TierProfileWriteSchema = z.object({
  routes: ScenarioRoutesSchema,
  constraints: RoutingConstraintsWriteSchema.default({
    blockedEscalationTiers: null,
    exhaustedBehavior: null,
    quotaSkipPct: null,
    errorRateSkipPct: null,
    minHealthSamples: null,
    autoTuneLongContext: null
  })
})
export type TierProfileWrite = z.infer<typeof TierProfileWriteSchema>

/**
 * The routing vocabulary the chain is organised by: the model tiers a
 * request is classified into and the scenario keys each chain is split
 * on.
 *
 * Domain rather than api because the request path and the UI both read
 * it — see the note in ./index.ts.
 */

import { z } from '@hono/zod-openapi'
import { SCENARIO_KEYS } from '@/shared/db/types'

// The four families of Claude models CC (and everything upstream of
// Rialto that speaks the Anthropic wire format) actually sends: fable,
// opus, sonnet, haiku. The tier is derived from the requested model
// name with case-insensitive substring matching, so `claude-opus-4-7`
// tiers to `opus` regardless of version suffix. The selector's tier
// gates and the per-model manual tier override both speak this
// vocabulary — the underlying string match is an implementation detail.
export const REQUESTED_MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type RequestedModelTier = (typeof REQUESTED_MODEL_TIERS)[number]

// Mirrors the Prisma ScenarioKey enum so the chain's per-scenario
// lanes, the seed and the UI all speak the same vocabulary. Derived from
// the SCENARIO_KEYS const tuple (kept in shared/db/types because it is
// plain data, not a Zod schema).
export const ScenarioKeySchema = z.enum(SCENARIO_KEYS)
export type ScenarioKey = z.infer<typeof ScenarioKeySchema>

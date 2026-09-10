/**
 * The scenario a request is classified into.
 *
 * Classification is the chain's first step: the scenario picks which
 * per-scenario lane the selector walks. `image` is a chain lane but not
 * a classifier outcome — nothing on the request path lands on it.
 */

import { z } from '@hono/zod-openapi'

// `background` was folded into `default` and no longer classifies as
// its own scenario at runtime.
export const ScenarioTypeSchema = z.enum(['default', 'think', 'longContext', 'webSearch'])
export type ScenarioType = z.infer<typeof ScenarioTypeSchema>

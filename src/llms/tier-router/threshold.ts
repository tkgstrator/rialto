/**
 * The Long context threshold: input tokens over which a request is
 * classified Long context.
 *
 * Its base is automatic — 70% of the context window of the model the
 * first usable default · agent route reaches, leaving the reply room — and
 * the routing scheduler's tuner moves it within [floor, base] by how the
 * Long context route's quota is going (`routing-scheduler/threshold-tuner.ts`).
 * Never above the base: a request that big would not fit the default model
 * it is being kept on.
 */

export const LONG_CONTEXT_AUTO_RATIO = 0.7
// When no default · agent route resolves to a model with a known window.
export const DEFAULT_LONG_CONTEXT_THRESHOLD = 128_000
// The tuner never lowers below this: under it, ordinary coding turns
// would all count as Long context.
export const LONG_CONTEXT_FLOOR = 30_000

export function longContextBase(defaultAgentWindow: number | null): number {
  return defaultAgentWindow === null ? DEFAULT_LONG_CONTEXT_THRESHOLD : Math.floor(defaultAgentWindow * LONG_CONTEXT_AUTO_RATIO)
}

/** The stored (tuned) value clamped to [floor, base], or the base when nothing is stored. */
export function effectiveLongContextThreshold(stored: number | null, base: number): number {
  if (stored === null) return base
  return Math.min(base, Math.max(Math.min(LONG_CONTEXT_FLOOR, base), stored))
}

/**
 * Weight-vector shaping: the three guards.
 *
 * Split from scoring because nothing here reads a quota window or a
 * request — it is arithmetic over a `RawScore` list and the previous
 * tick's vector. That is exactly what makes each guard testable on its
 * own: a hand-written score list is enough to exercise the probe floor,
 * the damper and the hold guard without constructing an account.
 *
 * **A weight is a per-candidate factor, not a share.** It used to be
 * normalised (`healthiness / Σ healthiness`) on the theory that the
 * vector was a traffic distribution. It never was one: the selector
 * walks the chain in priority order and only asks whether a weight is
 * zero. Normalising made every row depend on how many *other* targets
 * existed — including targets from other scenarios' chains, which the
 * tick unions into one vector — so the Chain screen showed numbers that
 * summed to neither 1 nor 100 and moved when an unrelated scenario was
 * edited. Each row now stands alone: 1.00 = fully healthy, 0.00 = will
 * not be picked.
 *
 * Order matters and is enforced by `computeWeights`, not here: floor
 * before damper (the floor can push a candidate past the per-tick delta,
 * and the damper is what walks it back), hold guard last (it judges the
 * vector that would actually ship).
 */

import type { RawScore } from './score'

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** The candidate's own score, clamped. Disabled entries publish zero. */
export const baseWeights = (raws: readonly RawScore[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const r of raws) out.set(r.target, r.enabled ? clamp01(r.healthiness) : 0)
  return out
}

// Probe floor: any enabled candidate with healthiness > 0 gets
// max(current, minWeightPct/100), so a recovering account keeps
// receiving probe traffic instead of sitting at zero forever.
export const applyProbeFloor = (
  raws: readonly RawScore[],
  initial: Map<string, number>,
  minWeightPct: number
): Map<string, number> => {
  const floor = minWeightPct / 100
  if (floor <= 0) return initial
  const boosted = new Map<string, number>()
  for (const r of raws) {
    if (!r.enabled || r.healthiness <= 0) {
      boosted.set(r.target, 0)
      continue
    }
    boosted.set(r.target, clamp01(Math.max(initial.get(r.target) ?? 0, floor)))
  }
  return boosted
}

// Oscillation damper: constrain each candidate's move vs `previous`.
export const applyDamper = (
  next: Map<string, number>,
  previous: ReadonlyMap<string, number> | null,
  maxDelta: number
): Map<string, number> => {
  if (previous === null) return next
  if (maxDelta >= 1) return next
  const clamped = new Map<string, number>()
  for (const [target, w] of next) {
    // Zero is a hard stop, not a movement: the scorer only publishes it
    // for a candidate that is disabled or has no budget left, and
    // `weight <= 0` is the single fact the request path reads. Walking
    // that down 0.2 a tick would keep sending traffic to an exhausted
    // account for maxDelta⁻¹ ticks — 25 minutes at the 5-minute default.
    // The damper exists to stop oscillation, not to brake a stop.
    if (w === 0) {
      clamped.set(target, 0)
      continue
    }
    const prev = previous.get(target) ?? w
    const upper = prev + maxDelta
    const lower = Math.max(0, prev - maxDelta)
    clamped.set(target, clamp01(Math.min(upper, Math.max(lower, w))))
  }
  return clamped
}

// Hold guard: if the top-preference candidate has healthy budget (>=
// 0.1) and its NEW weight would fall below minWeightPct/100, keep the
// previous vector unchanged. Prevents a compute bug from zeroing out
// a live primary.
export const holdGuardFires = (
  raws: readonly RawScore[],
  next: Map<string, number>,
  previous: ReadonlyMap<string, number> | null,
  minWeightPct: number
): boolean => {
  if (previous === null) return false
  const top = raws.find((r) => r.enabled)
  if (top === undefined) return false
  const budget = top.budgetPct
  if (budget === null || budget < 10) return false
  const w = next.get(top.target) ?? 0
  return w < minWeightPct / 100
}

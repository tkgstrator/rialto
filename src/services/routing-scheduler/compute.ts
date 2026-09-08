/**
 * Pure weight computation for the routing scheduler (Phase 2d).
 *
 * `computeWeights(state)` is a total function — no clock, no DB, no
 * global state. Every input arrives on the `SchedulerInputState`; the
 * `now` field is injected so the tick loop can pass `dayjs().valueOf()`
 * while tests can pin a fixed millisecond value.
 *
 * The score formula (plan doc §8.2) is:
 *
 *   budget(m)           = max over usable accounts of (1 - used/limit)
 *   err(m)              = errorRate5min (already 0..1 on input)
 *   resetPenalty(m)     = resetSoonFactor when timeToReset<threshold
 *                         AND budget<threshold, else 1.0
 *
 *   healthiness(m)      = budget × (1-err) × resetPenalty
 *   weight(m)           = healthiness, clamped to 0..1
 *
 * The plan's formula opened with `preferenceWeight = (N - rank)/N` and
 * closed with `healthiness / Σ healthiness`. Both are gone: the vector
 * was never consumed as a distribution (the selector walks the chain in
 * order and only tests `weight <= 0`), and between them they made a
 * healthy candidate's published number depend on its position and on how
 * many unrelated targets existed. A weight now says one thing about one
 * candidate — see `shaping.ts`.
 *
 * Then three guards apply (in order):
 *
 *   1. probe floor    — enabled candidates with healthiness > 0 keep at
 *                       least `minWeightPct/100`.
 *   2. oscillation    — `|w-previous| > maxDeltaPerTick` clamped to
 *                       previous±maxDeltaPerTick. Off by default when
 *                       `dampenerEnabled = false`.
 *   3. hold guard     — never zero-out a preference-primary candidate
 *                       that has healthy budget. Returns `held=true`
 *                       and the previous vector when the guard fires.
 */

// The pipeline is split across four modules so each stage can be read
// and tested for what it is: `quota-math` turns quota counters into
// per-candidate ratios, `score` applies the formula above, `shaping`
// applies the three guards, and this file is the order they run in.
import { type RawScore, scoreCandidate } from './score'
import { applyDamper, applyProbeFloor, baseWeights, holdGuardFires } from './shaping'
import type { ComputeResult, SchedulerInputState, WeightChange, WeightEntry } from './types'

export function computeWeights(state: SchedulerInputState): ComputeResult {
  const raws: RawScore[] = state.preferences.map((entry) =>
    scoreCandidate(entry.target, state.candidates.get(entry.target), state, entry.enabled)
  )

  const initial = baseWeights(raws)
  const floored = applyProbeFloor(raws, initial, state.constraints.minWeightPct)
  const damped = state.constraints.dampenerEnabled
    ? applyDamper(floored, state.previousWeights, state.constraints.maxDeltaPerTick)
    : floored

  if (holdGuardFires(raws, damped, state.previousWeights, state.constraints.minWeightPct)) {
    const heldEntries: WeightEntry[] = raws.map((r) => ({
      target: r.target,
      weight: state.previousWeights?.get(r.target) ?? 0,
      healthiness: r.healthiness,
      remainingBudgetPct: r.budgetPct,
      earliestResetAt: r.earliestResetAt,
      reasons: ['hold_guard'],
      paceRatio: r.paceRatio,
      windowElapsedRatio: r.windowElapsedRatio,
      contextWindow: r.contextWindow
    }))
    return { weights: heldEntries, held: true, changes: [] }
  }

  const entries: WeightEntry[] = raws.map((r) => ({
    target: r.target,
    weight: damped.get(r.target) ?? 0,
    healthiness: r.healthiness,
    remainingBudgetPct: r.budgetPct,
    earliestResetAt: r.earliestResetAt,
    reasons: r.reasons,
    paceRatio: r.paceRatio,
    windowElapsedRatio: r.windowElapsedRatio,
    contextWindow: r.contextWindow
  }))

  const changes: WeightChange[] = []
  if (state.previousWeights !== null) {
    for (const entry of entries) {
      const prev = state.previousWeights.get(entry.target) ?? 0
      if (Math.abs(entry.weight - prev) >= 0.01) {
        changes.push({
          target: entry.target,
          from: prev,
          to: entry.weight,
          reason: entry.reasons[0] ?? 'ok'
        })
      }
    }
  }

  return { weights: entries, held: false, changes }
}

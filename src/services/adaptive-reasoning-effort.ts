import { REASONING_EFFORTS, type ReasoningEffort } from '../shared/model-reasoning-effort'
import { getRoutingSnapshot, readRoutingSchedulerIntervalMs } from './routing-scheduler'

// Projected end-of-window usage, as a percentage of the quota. Under the
// surplus line there is headroom to spend on a higher effort; over the
// over-pace line the window will run out before it resets, so effort drops.
const PACE_SURPLUS_PCT = 60
const PACE_OVER_PCT = 100

const POSITIVE = REASONING_EFFORTS.filter((level) => level !== 'none')

export function effortForPace(
  projectedPct: number | null,
  supported: readonly ReasoningEffort[] | null
): ReasoningEffort | null {
  if (projectedPct === null || !Number.isFinite(projectedPct) || projectedPct < 0 || supported === null) return null
  const desired = projectedPct < PACE_SURPLUS_PCT ? 'high' : projectedPct > PACE_OVER_PCT ? 'low' : 'medium'
  const index = POSITIVE.indexOf(desired)
  const lower = POSITIVE.slice(0, index + 1).filter((level) => supported.includes(level))
  const choice = lower.at(-1)
  if (choice !== undefined) return choice
  const fallback = POSITIVE.find((level) => supported.includes(level))
  return fallback === undefined ? null : fallback
}

export function adaptiveEffortForTarget(
  target: string,
  supported: readonly ReasoningEffort[] | null,
  now = Date.now()
): { effort: ReasoningEffort; projectedPct: number } | null {
  const snapshot = getRoutingSnapshot()
  if (
    snapshot === null ||
    snapshot.tickAt > now ||
    now - snapshot.tickAt > 3 * readRoutingSchedulerIntervalMs() ||
    snapshot.degraded
  )
    return null
  const reading = snapshot.targets.get(target)
  if (
    reading === undefined ||
    reading.exhausted ||
    reading.remainingBudgetPct === null ||
    reading.projectedPct === null
  )
    return null
  const projectedPct = reading.projectedPct
  const effort = effortForPace(projectedPct, supported)
  return effort === null ? null : { effort, projectedPct }
}

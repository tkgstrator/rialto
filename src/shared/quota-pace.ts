/**
 * Project a quota window's use at reset at its observed pace.
 * Early projections can be noisy, but remain visible as the pace settles.
 * Routing can request a warm-up; unknown or expired windows stay unknown.
 */
export const PACE_MIN_ELAPSED = 0.1

export function windowProjectedPct(
  usedPct: number,
  resetAt: number | null,
  windowLengthMs: number | null,
  observedAt: number,
  minElapsed = 0
): number | null {
  if (
    !Number.isFinite(usedPct) ||
    resetAt === null ||
    !Number.isFinite(resetAt) ||
    windowLengthMs === null ||
    !Number.isFinite(windowLengthMs) ||
    windowLengthMs <= 0 ||
    !Number.isFinite(observedAt)
  )
    return null
  const elapsed = (observedAt - (resetAt - windowLengthMs)) / windowLengthMs
  if (elapsed <= 0 || elapsed < minElapsed || elapsed > 1) return null
  return usedPct / elapsed
}

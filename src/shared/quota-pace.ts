/**
 * Project a quota window's use at reset at its observed pace.
 * A few early requests are noisy, so no projection is made during the
 * first tenth of the window. Unknown or expired windows stay unknown.
 */
export const PACE_MIN_ELAPSED = 0.1

export function windowProjectedPct(
  usedPct: number,
  resetAt: number | null,
  windowLengthMs: number | null,
  observedAt: number
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
  if (elapsed < PACE_MIN_ELAPSED || elapsed > 1) return null
  return usedPct / elapsed
}

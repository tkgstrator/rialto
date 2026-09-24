/**
 * Shared types for the routing scheduler's quota snapshot.
 *
 * Kept in a leaf module so `targets.ts` (pure), `state.ts` (in-process
 * snapshot store), and `index.ts` (tick loop) can all import them
 * without a cycle. Nothing here reaches out to the DB or upstream
 * APIs — those live in the collector and the tick loop.
 */

// One rate-limit window normalised to the pct-based used/limit +
// reset shape the collector already writes.
export interface QuotaWindowState {
  used: number
  limit: number
  resetAt: number | null // epoch ms
  windowLengthMs: number | null
}

export interface AccountQuotaState {
  subAccountId: string
  kind: 'claude' | 'codex'
  // Provider row's name (`claude-code`, `codex`, ...); the same value
  // that appears before the comma in a "provider,model" target.
  providerName: string
  // Zero to two windows (5h, weekly). Missing entries stay undefined so
  // an account whose upstream call has never succeeded reads as unknown,
  // not as spent.
  fiveHour: QuotaWindowState | undefined
  weekly: QuotaWindowState | undefined
  // Fable-specific 7-day scoped window when the upstream reports one.
  // Anthropic emits per-model `weekly_scoped` entries only for Fable
  // today (Opus / Sonnet share the account-wide weekly), so the
  // scheduler carries a single dedicated slot rather than a generic map.
  scopedFable: QuotaWindowState | undefined
  // Plan capacity multiplier (Pro=1, Max=5, Max20=20): a Max20 account
  // at 0% should drag the pool budget down more than a Pro one would.
  planWeight: number
  // When the collector last wrote a value for this account. Null for a
  // cold-start account that has never been polled.
  refreshedAt: number | null
}

// One "provider,model" target and the accounts that serve it.
export interface ModelCandidateState {
  target: string
  providerName: string
  modelName: string
  accounts: readonly AccountQuotaState[]
}

// What the request path reads for one target.
export interface TargetQuotaState {
  target: string
  // Every account behind the target reads as spent right now. Only a
  // fresh, known reading counts: an account never polled, or one whose
  // reading has gone stale, leaves the target open — the upstream's own
  // 429 is then the judge, and marks it.
  exhausted: boolean
  // Capacity-weighted remaining budget across the target's accounts,
  // 0..100. Null when no account has a fresh reading.
  remainingBudgetPct: number | null
  // Where the target lands at its reset if use keeps its current pace, as
  // a percentage of the budget: 100 = exactly spent. Over 100 the router
  // steps down to the next route; well under it, the route is pulled to
  // the front. Null until a window is far enough in to judge.
  projectedPct: number | null
  // When the budget next refills: for an exhausted target, when its
  // first account can serve again.
  resetAt: number | null
}

// Per-account view exposed on the API / UI.
export interface AccountQuotaView {
  subAccountId: string
  providerName: string
  kind: 'claude' | 'codex'
  fiveHour: QuotaWindowState | null
  weekly: QuotaWindowState | null
  refreshedAt: number | null
  stale: boolean
}

// The published snapshot the selector reads on every request. Frozen
// object; the publisher swaps the reference so readers never see a
// half-updated state.
export interface RoutingSnapshot {
  tickAt: number // epoch ms of the last successful tick
  tickCount: number
  consecutiveFailures: number
  // Some account's reading is older than three poll intervals, so the
  // exhaustion the snapshot reports may no longer be true.
  degraded: boolean
  // Keyed by "provider,model": every enabled model of every enabled
  // subscription provider. A target absent from it (api_key providers)
  // has no quota the scheduler knows about and is never held on one.
  targets: ReadonlyMap<string, TargetQuotaState>
  accounts: readonly AccountQuotaView[]
  // Earliest reset across the exhausted targets.
  soonestResetAt: number | null
}

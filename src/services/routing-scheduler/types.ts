/**
 * Shared types for the quota-aware routing scheduler (Phase 2d).
 *
 * Kept in a leaf module so `compute.ts` (pure), `state.ts` (in-process
 * snapshot store), and `index.ts` (tick loop) can all import them
 * without a cycle. Nothing here reaches out to the DB or upstream
 * APIs — those live in the collector and the tick loop.
 */

import type { QuotaAwareConstraints, RouterPreferenceEntry } from '../../schemas/domain/preference'
// One rate-limit window normalised to the pct-based used/limit +
// reset shape the collector already writes. `windowLengthMs` is used
// by drain-target math; null when the collector didn't observe it.
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
  // that appears before the comma in a preference target string.
  providerName: string
  // Zero to two windows (5h, weekly). Missing entries stay undefined
  // so `computeWeights` can treat the account as unknown-budget when
  // an upstream call has never succeeded.
  fiveHour: QuotaWindowState | undefined
  weekly: QuotaWindowState | undefined
  // Fable-specific 7-day scoped window when the upstream reports one.
  // Anthropic emits per-model `weekly_scoped` entries only for Fable
  // today (Opus / Sonnet share the account-wide weekly), so the
  // scheduler carries a single dedicated slot rather than a generic
  // map. Undefined when the account has never observed the scoped
  // limit — the compute step falls back to fiveHour / weekly then.
  scopedFable: QuotaWindowState | undefined
  // Plan capacity multiplier (Pro=1, Max=5, Max20=20). Used by
  // `modelBudget` to weight each account's remaining-budget ratio when
  // averaging across the accounts backing a candidate model — a Max20
  // account at 0% should drag the pool budget down more than a Pro
  // account at 0% would. Defaults to 1 for unknown/free plans.
  planWeight: number
  // When the collector last wrote a value for this account. Null for
  // a cold-start account that has never been polled. Used together
  // with `constraints.staleQuotaFactor` and `unknownBudgetPolicy`.
  refreshedAt: number | null
}

// Model-level candidate state used by the pure `computeWeights`.
// One entry per preference target so the compute function can attach
// the corresponding account state without walking the preference
// chain again.
export interface ModelCandidateState {
  target: string
  providerName: string
  modelName: string
  // Which accounts serve this target. The budget aggregator averages
  // remaining-ratio across this list weighted by each account's
  // planWeight so a small full account cannot mask a large exhausted
  // peer.
  accounts: readonly AccountQuotaState[]
  // Recent 5-min error rate (0-1). Callers back this with the Phase 2e
  // model-health tracker; a fresh model with no samples yet is passed
  // in as 0.
  errorRate: number
  // Max input tokens the model accepts, mirrored from Model.contextWindow.
  // Null when the scraper hasn't captured the value (subscription-only
  // models, models the vendor page doesn't publish). The selector's
  // context-window gate treats null as "unknown, allow" so a fresh
  // seed doesn't block routing.
  contextWindow: number | null
}

// Snapshot input the tick loop feeds to `computeWeights`. Deliberately
// serialisable / clone-safe so the pure function stays deterministic
// with an injected `now`.
export interface SchedulerInputState {
  now: number
  preferences: readonly RouterPreferenceEntry[]
  candidates: ReadonlyMap<string, ModelCandidateState>
  previousWeights: ReadonlyMap<string, number> | null
  constraints: QuotaAwareConstraints
  // Poll TTL in ms — used to decide when a quota is "stale". The tick
  // reads this from `usage-service/cache.ts` so the two numbers can't
  // drift.
  ttlMs: number
}

// Machine-readable reasons attached to each weight entry so the audit
// log (`RoutingWeightChange`) and the UI can label a change without
// re-implementing the compute logic.
export type WeightReason =
  | 'ok'
  | 'quota_drop'
  | 'quota_recovered'
  | 'error_rate'
  | 'reset_soon'
  | 'stale_quota'
  | 'probe_floor'
  | 'hold_guard'
  | 'unknown_budget'
  | 'no_quota_kind'

export interface WeightEntry {
  target: string
  // 0..1 for this candidate alone — NOT a share of the chain, so a
  // column of these does not sum to anything. 0 means the selector will
  // skip it; that zero-ness is the only thing the request path reads.
  weight: number
  // The same score before the probe floor / damper / hold guard.
  healthiness: number
  remainingBudgetPct: number | null // 0..100; null = unknown
  earliestResetAt: number | null
  reasons: readonly WeightReason[]
  // consumed% / elapsed% on the account's tightest binding window
  // (min across the candidate's usable accounts, tightest of 5h/weekly
  // for each). > 1 = burning too fast; < 1 = slack.
  // Null when no account has enough info (unknown budget or the
  // account is cold-start with no windowLengthMs).
  paceRatio: number | null
  // 0..1 fraction of the binding window that has already elapsed.
  // Null when unknown. Consulted before applying pace-based tier
  // shifts so early-window noise doesn't flip the tier.
  windowElapsedRatio: number | null
  // Model.contextWindow, mirrored on the snapshot so the selector's
  // context-window gate can reject candidates that physically cannot
  // serve the current request's token count without a fresh Prisma
  // read on every request. Null = unknown; the gate allows.
  contextWindow: number | null
}

export interface WeightChange {
  target: string
  from: number
  to: number
  reason: WeightReason
}

export interface ComputeResult {
  weights: readonly WeightEntry[]
  // True when the hold-guard fired — the pure function returned the
  // previous vector unchanged. The tick loop bumps `consecutiveHolds`
  // and, past a threshold, marks the snapshot degraded so operators
  // can spot a stuck scheduler.
  held: boolean
  // Only entries whose weight moved by >= 0.01 vs the previous vector.
  // Empty on the first tick or when nothing changed.
  changes: readonly WeightChange[]
}

// Per-account view exposed on the API / UI. Contains the same
// information the compute function used, so the dashboard can render
// "why is this account 0%?" without re-running the math.
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
  tickAt: number // epoch ms of the last successful compute
  tickCount: number
  consecutiveFailures: number
  // True when successive holds or missing collector data have made
  // the snapshot unreliable — surfaced on the API for operator visibility.
  degraded: boolean
  weights: ReadonlyMap<string, WeightEntry>
  accounts: readonly AccountQuotaView[]
  // Earliest binding-window reset across all exhausted candidates.
  // Selector uses this for the 429 Retry-After header (Phase 2e).
  soonestResetAt: number | null
}

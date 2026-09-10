/**
 * Routing scheduler tick loop (Phase 2d).
 *
 * In-process `setTimeout` chain — not BullMQ — because:
 *   1. the snapshot lives in process memory; there's no reason to run
 *      the tick anywhere else,
 *   2. Redis-death must not block routing decisions,
 *   3. 5min–1h cadence is well inside a single Node/Bun process's
 *      reliability budget.
 *
 * The chain is drift-corrected: each tick reschedules itself relative
 * to `dayjs().valueOf()`, so a slow tick doesn't compound. A globalThis
 * flag makes the start idempotent under Vite HMR / SSR re-evaluation.
 *
 * The tick body is fully try/caught. On failure `consecutiveFailures`
 * increments and the previous snapshot stays published — routing never
 * blocks because compute threw. Test hooks: `runSchedulerTickForTest()`
 * runs one tick synchronously without arming the timer.
 */

import { planCapacityWeight } from '@/shared/plan-capacity'
import { getPrismaClient } from '../../db/client'
import type { PrismaClient } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import { type QuotaAwareConstraints, QuotaAwareConstraintsSchema } from '../../schemas/domain/preference'
import { loadRouterPreferences } from '../router-preference-service'
import { refreshQuotaSnapshots } from './collector'
import { computeWeights } from './compute'
import {
  getRoutingSnapshot,
  publishSnapshot,
  recordWeightChanges,
  __resetSchedulerStateForTest as resetStateForTest
} from './state'
import type {
  AccountQuotaState,
  AccountQuotaView,
  ModelCandidateState,
  QuotaWindowState,
  RoutingSnapshot,
  SchedulerInputState
} from './types'

const DEFAULT_TICK_MS = 300_000 // 5 min, matches plan doc §6.4 default
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000 // must match usage-service/cache.ts

declare global {
  var __rialtoRoutingSchedulerStarted: boolean | undefined
  var __rialtoRoutingSchedulerTimer: ReturnType<typeof setTimeout> | undefined
}

let consecutiveFailures = 0
let consecutiveHolds = 0
let tickCount = 0

const readIntervalMs = (): number => {
  const raw = process.env.ROUTING_SCHEDULER_INTERVAL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_TICK_MS
}

// `shouldRunTick` gated this on ROUTER_MODE: the weights only fed the
// quota-aware selector, so under the rules selector the scheduler armed
// itself and never ran. The chain is the only selector now, so the tick
// always has a consumer.

// Convert a DB quota row into the in-memory window shape. Missing
// values collapse to undefined so `computeWeights` can distinguish
// "no data" from "zero remaining".
const windowFromDb = (
  used: number | null,
  limit: number | null,
  resetAt: Date | null,
  windowSeconds: number | null
): QuotaWindowState | undefined => {
  if (used === null || limit === null) return undefined
  return {
    used,
    limit,
    resetAt: resetAt === null ? null : resetAt.valueOf(),
    windowLengthMs: windowSeconds === null ? null : windowSeconds * 1000
  }
}

// Length of the scoped weekly window Anthropic publishes for Fable —
// same 7 days as the account-wide weekly (the collector writes account
// weekly as CLAUDE_WEEKLY_SECONDS). Kept local to avoid pulling the
// collector's constants into the scheduler entry-point.
const SCOPED_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000

// Extract the Fable scoped weekly window from `SubAccountQuota.scopedWindows`.
// The collector writes `{ <modelSlug>: { used, limit, resetAt } }` (see
// `scopedWindowsFor` in collector.ts); we look up the `fable` slug and
// hydrate a QuotaWindowState. Any parse/shape mismatch collapses to
// undefined so a corrupt row still yields a working snapshot.
const fableFromScoped = (raw: unknown): QuotaWindowState | undefined => {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = (raw as Record<string, unknown>).fable
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
  const rec = entry as Record<string, unknown>
  const used = typeof rec.used === 'number' ? rec.used : null
  const limit = typeof rec.limit === 'number' ? rec.limit : null
  if (used === null || limit === null) return undefined
  const resetAtRaw = rec.resetAt
  const resetAt =
    typeof resetAtRaw === 'string' && resetAtRaw !== ''
      ? dayjs(resetAtRaw).isValid()
        ? dayjs(resetAtRaw).valueOf()
        : null
      : null
  return { used, limit, resetAt, windowLengthMs: SCOPED_WEEKLY_MS }
}

interface LoadedState {
  candidates: Map<string, ModelCandidateState>
  accounts: AccountQuotaView[]
}

// Build the per-candidate state map by joining preference targets to
// Model → Provider → SubAccount(quota) rows. Every preference entry
// is preserved; targets whose model has no accounts (or the model is
// gone entirely) still get an empty `accounts` array so the compute
// function can attach `no_quota_kind` / `unknown_budget`.
async function loadCandidateState(prisma: PrismaClient): Promise<LoadedState> {
  const preferences = await loadRouterPreferences(prisma)
  const providers = await prisma.provider.findMany({
    include: {
      models: true,
      subscriptionAccounts: { include: { quota: true } }
    }
  })
  const modelIndex = new Map<
    string,
    { providerName: string; kind: 'claude' | 'codex' | null; contextWindow: number | null }
  >()
  const accountsByProvider = new Map<string, AccountQuotaState[]>()
  const accountViews: AccountQuotaView[] = []
  for (const p of providers) {
    const kind: 'claude' | 'codex' | null =
      p.authMode === 'subscription' ? (p.name.toLowerCase().includes('codex') ? 'codex' : 'claude') : null
    for (const m of p.models)
      modelIndex.set(`${p.name},${m.name}`, {
        providerName: p.name,
        kind,
        contextWindow: m.contextWindow
      })
    if (kind === null) continue
    const accts: AccountQuotaState[] = []
    for (const a of p.subscriptionAccounts) {
      const q = a.quota
      const fiveHour =
        q === null
          ? undefined
          : windowFromDb(q.fiveHourUsed, q.fiveHourLimit, q.fiveHourResetAt, q.fiveHourWindowSeconds)
      const weekly =
        q === null ? undefined : windowFromDb(q.weeklyUsed, q.weeklyLimit, q.weeklyResetAt, q.weeklyWindowSeconds)
      const scopedFable = q === null ? undefined : fableFromScoped(q.scopedWindows)
      const refreshedAt = q?.quotaRefreshedAt ? q.quotaRefreshedAt.valueOf() : null
      accts.push({
        subAccountId: a.id,
        kind,
        providerName: p.name,
        fiveHour,
        weekly,
        scopedFable,
        planWeight: planCapacityWeight(kind, a.plan, a.rateLimitTier),
        refreshedAt
      })
      accountViews.push({
        subAccountId: a.id,
        providerName: p.name,
        kind,
        fiveHour: fiveHour ?? null,
        weekly: weekly ?? null,
        refreshedAt,
        stale: false // recomputed below with `now`
      })
    }
    accountsByProvider.set(p.name, accts)
  }

  const candidates = new Map<string, ModelCandidateState>()
  // Union targets across every scenario's chain — the snapshot's
  // weight map is keyed by target regardless of scenario, so each
  // unique target gets one candidate entry. Per-scenario rank is
  // reapplied by the selector at request time.
  const seenTargets = new Set<string>()
  for (const scenario of ['default', 'think', 'longContext', 'webSearch', 'image'] as const) {
    for (const kind of ['agent', 'subagent'] as const) {
      for (const entry of preferences.entriesByScenario[scenario][kind]) {
        if (seenTargets.has(entry.target)) continue
        seenTargets.add(entry.target)
        const info = modelIndex.get(entry.target)
        if (info === undefined) {
          candidates.set(entry.target, {
            target: entry.target,
            providerName: '',
            modelName: '',
            accounts: [],
            errorRate: 0,
            contextWindow: null
          })
          continue
        }
        const modelName = entry.target.slice(info.providerName.length + 1)
        candidates.set(entry.target, {
          target: entry.target,
          providerName: info.providerName,
          modelName,
          accounts: accountsByProvider.get(info.providerName) ?? [],
          errorRate: 0, // Phase 2e will fill from the model-health tracker
          contextWindow: info.contextWindow
        })
      }
    }
  }

  return { candidates, accounts: accountViews }
}

const resolveConstraints = (raw: unknown): QuotaAwareConstraints => {
  const parsed = QuotaAwareConstraintsSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : QuotaAwareConstraintsSchema.parse({})
}

// Compute the earliest reset time across every candidate whose weight
// is zero — the Retry-After source for the all-exhausted branch.
const soonestResetOf = (weights: readonly { weight: number; earliestResetAt: number | null }[]): number | null => {
  let soonest: number | null = null
  for (const w of weights) {
    if (w.weight > 0) continue
    if (w.earliestResetAt === null) continue
    if (soonest === null || w.earliestResetAt < soonest) soonest = w.earliestResetAt
  }
  return soonest
}

// The whole tick body — extracted so the test hook can run it without
// starting a timer.
export async function runSchedulerTickForTest(prismaOverride?: PrismaClient): Promise<RoutingSnapshot | null> {
  const prisma = prismaOverride ?? getPrismaClient()
  try {
    const now = dayjs().valueOf()
    await refreshQuotaSnapshots(undefined, prisma)
    const { candidates, accounts } = await loadCandidateState(prisma)
    const preferences = await loadRouterPreferences(prisma)
    const previous = getRoutingSnapshot()
    const previousWeights = previous === null ? null : previous.weights
    const constraints = resolveConstraints(preferences.constraints)
    // Union preferences across all scenarios into a single virtual
    // chain for compute purposes: the snapshot exposes one weight per
    // unique target and the selector reapplies per-scenario ordering.
    // Rank uses the best (lowest) priority the target holds anywhere.
    const seen = new Map<string, { priority: number; enabled: boolean }>()
    for (const scenario of ['default', 'think', 'longContext', 'webSearch', 'image'] as const) {
      for (const kind of ['agent', 'subagent'] as const) {
        for (const entry of preferences.entriesByScenario[scenario][kind]) {
          const prev = seen.get(entry.target)
          if (prev === undefined || entry.priority < prev.priority) {
            seen.set(entry.target, {
              priority: entry.priority,
              enabled: entry.enabled || (prev?.enabled ?? false)
            })
          }
        }
      }
    }
    const unionEntries = [...seen.entries()]
      .sort((a, b) => a[1].priority - b[1].priority)
      .map(([target, v], i) => ({
        priority: i + 1,
        target,
        enabled: v.enabled
      }))
    const input: SchedulerInputState = {
      now,
      preferences: unionEntries,
      candidates,
      previousWeights: previousWeights === null ? null : new Map([...previousWeights].map(([k, v]) => [k, v.weight])),
      constraints,
      ttlMs: USAGE_CACHE_TTL_MS
    }
    const result = computeWeights(input)
    if (result.held) consecutiveHolds += 1
    else consecutiveHolds = 0
    const weightMap = new Map(result.weights.map((w) => [w.target, w]))
    const staleAccounts = accounts.map((a) => ({
      ...a,
      stale: a.refreshedAt !== null && now - a.refreshedAt > 3 * USAGE_CACHE_TTL_MS
    }))
    const snapshot: RoutingSnapshot = {
      tickAt: now,
      tickCount: ++tickCount,
      consecutiveFailures: 0,
      degraded: consecutiveHolds >= 5,
      weights: weightMap,
      accounts: staleAccounts,
      soonestResetAt: soonestResetOf(result.weights)
    }
    publishSnapshot(snapshot)
    recordWeightChanges(result.changes, now)
    if (result.changes.length > 0) {
      await prisma.routingWeightChange.createMany({
        data: result.changes.map((c) => ({
          target: c.target,
          fromWeight: c.from,
          toWeight: c.to,
          reason: c.reason,
          tickAt: dayjs(now).toDate()
        }))
      })
    }
    consecutiveFailures = 0
    return snapshot
  } catch (err) {
    consecutiveFailures += 1
    logger.warn({ err, consecutiveFailures }, '[routing-scheduler] tick failed — keeping previous snapshot')
    return null
  }
}

// Drift-corrected setTimeout chain. Each tick reschedules relative to
// `dayjs().valueOf()`, so a slow tick shortens the next delay but never
// compounds.
export function startRoutingScheduler(): void {
  if (globalThis.__rialtoRoutingSchedulerStarted) return
  globalThis.__rialtoRoutingSchedulerStarted = true

  const intervalMs = readIntervalMs()
  logger.info({ intervalMs }, '[routing-scheduler] armed')

  const scheduleNext = (): void => {
    if (!globalThis.__rialtoRoutingSchedulerStarted) return
    const start = dayjs().valueOf()
    globalThis.__rialtoRoutingSchedulerTimer = setTimeout(async () => {
      await runSchedulerTickForTest()
      const elapsed = dayjs().valueOf() - start
      const delay = Math.max(1_000, intervalMs - elapsed)
      if (globalThis.__rialtoRoutingSchedulerStarted) {
        globalThis.__rialtoRoutingSchedulerTimer = setTimeout(scheduleNext, delay)
      }
    }, intervalMs)
  }

  scheduleNext()
}

export function stopRoutingScheduler(): void {
  globalThis.__rialtoRoutingSchedulerStarted = false
  if (globalThis.__rialtoRoutingSchedulerTimer !== undefined) {
    clearTimeout(globalThis.__rialtoRoutingSchedulerTimer)
    globalThis.__rialtoRoutingSchedulerTimer = undefined
  }
}

export function __resetSchedulerForTest(): void {
  stopRoutingScheduler()
  resetStateForTest()
  consecutiveFailures = 0
  consecutiveHolds = 0
  tickCount = 0
}

export { getRecentWeightChanges, getRoutingSnapshot } from './state'

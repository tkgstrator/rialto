/**
 * Routing scheduler tick loop: the quota snapshot the tier router reads.
 *
 * Each tick collects fresh quota, holds spent accounts, and publishes one
 * reading per target — every enabled model of every enabled subscription
 * provider: is it out, how much is left, when does it come back. It no
 * longer computes weights: the request path only ever asked whether a
 * weight was zero, and the tier map says what order to try routes in.
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
 * blocks because a tick threw. `runSchedulerTick()` runs one tick
 * without arming the timer; `republishRoutingSnapshot()` runs one after
 * fresh quota has been written. Neither overlaps a tick already running.
 */

import { z } from 'zod'
import { planCapacityWeight } from '@/shared/plan-capacity'
import { getPrismaClient } from '../../db/client'
import type { PrismaClient, SubAccount, SubAccountQuota } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import { holdSpentAccount } from './account-limit'
import { refreshQuotaSnapshots } from './collector'
import { publishSnapshot, __resetSchedulerStateForTest as resetStateForTest } from './state'
import { soonestResetOf, targetQuotaOf } from './targets'
import { tuneLongContextThresholds } from './threshold-tuner'
import type {
  AccountQuotaState,
  AccountQuotaView,
  ModelCandidateState,
  QuotaWindowState,
  RoutingSnapshot
} from './types'

const DEFAULT_TICK_MS = 300_000 // 5 min, matches plan doc §6.4 default
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000 // must match usage-service/cache.ts

declare global {
  var __rialtoRoutingSchedulerStarted: boolean | undefined
  var __rialtoRoutingSchedulerTimer: ReturnType<typeof setTimeout> | undefined
}

const counters = { consecutiveFailures: 0, tickCount: 0 }

const readIntervalMs = (): number => {
  const raw = process.env.ROUTING_SCHEDULER_INTERVAL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_TICK_MS
}

// Convert a DB quota row into the in-memory window shape. Missing
// values collapse to undefined so the budget can distinguish "no data"
// from "zero remaining".
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
const ScopedFableSchema = z.object({
  fable: z.object({ used: z.number(), limit: z.number(), resetAt: z.string().nullable().optional() })
})

const fableFromScoped = (raw: unknown): QuotaWindowState | undefined => {
  const parsed = ScopedFableSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const { used, limit, resetAt: resetAtRaw } = parsed.data.fable
  const resetAt =
    typeof resetAtRaw === 'string' && resetAtRaw !== '' && dayjs(resetAtRaw).isValid()
      ? dayjs(resetAtRaw).valueOf()
      : null
  return { used, limit, resetAt, windowLengthMs: SCOPED_WEEKLY_MS }
}

interface LoadedState {
  candidates: Map<string, ModelCandidateState>
  accounts: AccountQuotaView[]
}

// Build the per-target state map: every enabled model of every enabled
// subscription provider, each with its provider's accounts. It used to be
// the targets of the `live` profile's chain only, which left every other
// profile's routes unguarded on quota; a tier route can name any of these,
// so all of them are read.
async function loadCandidateState(prisma: PrismaClient): Promise<LoadedState> {
  const providers = await prisma.provider.findMany({
    where: { authMode: 'subscription' },
    include: {
      models: { where: { enabled: true }, select: { name: true } },
      subscriptionAccounts: { include: { quota: true } }
    }
  })
  const candidates = new Map<string, ModelCandidateState>()
  const accountViews: AccountQuotaView[] = []
  for (const p of providers) {
    const kind: 'claude' | 'codex' = p.name.toLowerCase().includes('codex') ? 'codex' : 'claude'
    const accounts = p.subscriptionAccounts.map((a) => accountStateOf(a, p.name, kind))
    accountViews.push(...accounts.map(viewOf))
    if (!p.enabled) continue
    for (const m of p.models) {
      const target = `${p.name},${m.name}`
      candidates.set(target, { target, providerName: p.name, modelName: m.name, accounts })
    }
  }
  return { candidates, accounts: accountViews }
}

type AccountRow = SubAccount & { quota: SubAccountQuota | null }

function accountStateOf(a: AccountRow, providerName: string, kind: 'claude' | 'codex'): AccountQuotaState {
  const q = a.quota
  // The row is the vendor's reading. Held here, before the snapshot and
  // the published view read it, so a spent 5h or 7d reaches the Fable
  // budget and the Retry-After without being written back into the
  // table the panels draw from.
  const { fiveHour, weekly, scopedFable } = holdSpentAccount({
    fiveHour:
      q === null
        ? undefined
        : windowFromDb(q.fiveHourUsed, q.fiveHourLimit, q.fiveHourResetAt, q.fiveHourWindowSeconds),
    weekly: q === null ? undefined : windowFromDb(q.weeklyUsed, q.weeklyLimit, q.weeklyResetAt, q.weeklyWindowSeconds),
    scopedFable: q === null ? undefined : fableFromScoped(q.scopedWindows)
  })
  return {
    subAccountId: a.id,
    kind,
    providerName,
    fiveHour,
    weekly,
    scopedFable,
    planWeight: planCapacityWeight(kind, a.plan, a.rateLimitTier),
    refreshedAt: q !== null && q.quotaRefreshedAt !== null ? q.quotaRefreshedAt.valueOf() : null
  }
}

const viewOf = (a: AccountQuotaState): AccountQuotaView => ({
  subAccountId: a.subAccountId,
  providerName: a.providerName,
  kind: a.kind,
  fiveHour: a.fiveHour === undefined ? null : a.fiveHour,
  weekly: a.weekly === undefined ? null : a.weekly,
  refreshedAt: a.refreshedAt,
  stale: false // recomputed by the tick with `now`
})

// The tick in flight, and the one queued behind it. Two ticks must not
// overlap: the older one could publish last and put a reading the other
// had already replaced back in front of the router.
const tickState: {
  running: Promise<RoutingSnapshot | null> | null
  queued: Promise<RoutingSnapshot | null> | null
} = { running: null, queued: null }

const startTick = (collect: boolean, prismaOverride?: PrismaClient): Promise<RoutingSnapshot | null> => {
  const run = tickBody(collect, prismaOverride).finally(() => {
    tickState.running = null
  })
  tickState.running = run
  return run
}

// One scheduler tick. A caller that arrives while one is running shares
// it — the timer never needs two.
export function runSchedulerTick(prismaOverride?: PrismaClient): Promise<RoutingSnapshot | null> {
  return tickState.running !== null ? tickState.running : startTick(true, prismaOverride)
}

/**
 * Publish a snapshot computed from what is in the database now.
 *
 * For a caller that has just written fresh quota — a manual Refresh, a
 * spent reset credit. Joining a tick already in flight would not do: it
 * read SubAccountQuota before the write and would publish the old
 * reading. So a tick that is running is let finish, and one more starts
 * after it; callers arriving in the meantime share that one.
 *
 * That tick skips the collection step. The caller has already written
 * the rows it holds fresh readings for, and collecting again would land
 * the usage cache over them — including the stale value an account whose
 * upstream call just failed still has there, which the refresh
 * deliberately left unwritten.
 */
export function republishRoutingSnapshot(): Promise<RoutingSnapshot | null> {
  if (tickState.running === null) return startTick(false)
  if (tickState.queued !== null) return tickState.queued
  const queued = tickState.running.then(() => {
    tickState.queued = null
    return startTick(false)
  })
  tickState.queued = queued
  return queued
}

// The whole tick body. Never called directly: `runSchedulerTick` and
// `republishRoutingSnapshot` are what keep two of these from overlapping.
async function tickBody(collect: boolean, prismaOverride?: PrismaClient): Promise<RoutingSnapshot | null> {
  const prisma = prismaOverride === undefined ? getPrismaClient() : prismaOverride
  try {
    const now = dayjs().valueOf()
    if (collect) await refreshQuotaSnapshots(undefined, prisma)
    const { candidates, accounts } = await loadCandidateState(prisma)
    const targets = new Map([...candidates.values()].map((c) => [c.target, targetQuotaOf(c, now, USAGE_CACHE_TTL_MS)]))
    const withStaleness = accounts.map((a) => ({
      ...a,
      stale: a.refreshedAt !== null && now - a.refreshedAt > 3 * USAGE_CACHE_TTL_MS
    }))
    counters.tickCount += 1
    const snapshot: RoutingSnapshot = {
      tickAt: now,
      tickCount: counters.tickCount,
      consecutiveFailures: 0,
      degraded: withStaleness.some((a) => a.stale),
      targets,
      accounts: withStaleness,
      soonestResetAt: soonestResetOf(targets.values())
    }
    publishSnapshot(snapshot)
    // Timer ticks only: a republish after a Refresh is about fresh quota,
    // and the tuner acts at most once a day anyway.
    if (collect) await tuneLongContextThresholds(prisma, snapshot, now)
    counters.consecutiveFailures = 0
    return snapshot
  } catch (err) {
    counters.consecutiveFailures += 1
    logger.warn(
      { err, consecutiveFailures: counters.consecutiveFailures },
      '[routing-scheduler] tick failed — keeping previous snapshot'
    )
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
      await runSchedulerTick()
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
  counters.consecutiveFailures = 0
  counters.tickCount = 0
}

export { getRoutingSnapshot } from './state'

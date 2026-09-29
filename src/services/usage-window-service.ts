/**
 * Usage windows: what a token on a plan has spent in the current 5-hour
 * and 7-day windows, and whether it may spend more.
 *
 * Modelled on the subscription quotas rather than on a sliding window.
 * A window opens at the first request counted while none is open and
 * lasts a fixed length from there; once `startedAt` + length has passed
 * it is over, and the next admission opens a fresh one. That makes "when
 * does it reset" a single timestamp an operator and a client can both be
 * told, which a sliding window cannot offer.
 *
 * Two quantities per window. Requests are counted at admission, before
 * the call; spend is only known after it, so it is added when the cost is
 * recorded — a call that pushes a window over its spend limit completes,
 * and the next one is refused.
 *
 * Every timestamp comes from dayjs (so from the process clock, which
 * tests move with `setSystemTime`), never from Postgres `now()`.
 */

import { z } from 'zod'
import { getPrismaClient } from '../db/client'
import dayjs, { type Dayjs } from '../lib/dayjs'
import { buildPriceMap, computeCosts } from './cost-service'

export const UsageWindowSchema = z.enum(['5h', '7d'])
export type UsageWindow = z.infer<typeof UsageWindowSchema>

export const USAGE_WINDOWS: readonly UsageWindow[] = UsageWindowSchema.options

const WINDOW_HOURS: Readonly<Record<UsageWindow, number>> = { '5h': 5, '7d': 7 * 24 }

/** One window's two limits. Null = no limit on that axis. */
export interface WindowLimit {
  requests: number | null
  spendUsd: number | null
}

export type PlanLimits = Readonly<Record<UsageWindow, WindowLimit>>

/** The four plan columns as the window-keyed shape the gate reads. */
export const planLimitsOf = (plan: {
  fiveHourRequestLimit: number | null
  fiveHourSpendLimitUsd: number | null
  sevenDayRequestLimit: number | null
  sevenDaySpendLimitUsd: number | null
}): PlanLimits => ({
  '5h': { requests: plan.fiveHourRequestLimit, spendUsd: plan.fiveHourSpendLimitUsd },
  '7d': { requests: plan.sevenDayRequestLimit, spendUsd: plan.sevenDaySpendLimitUsd }
})

export const hasAnyLimit = (limits: PlanLimits): boolean =>
  USAGE_WINDOWS.some((window) => limits[window].requests !== null || limits[window].spendUsd !== null)

const resetOf = (window: UsageWindow, startedAt: Date): Dayjs => dayjs(startedAt).add(WINDOW_HOURS[window], 'hour')

/** Whether a window that started at `startedAt` is still the current one at `now`. */
const isOpen = (window: UsageWindow, startedAt: Date, now: Dayjs): boolean => resetOf(window, startedAt).isAfter(now)

interface StoredWindow {
  window: UsageWindow
  startedAt: Date
  requests: number
  costUsd: number
}

/** A token's stored rows, with any row whose window id is not one we know dropped. */
async function storedWindows(
  client: Pick<ReturnType<typeof getPrismaClient>, 'accessTokenUsageWindow'>,
  tokenId: string
): Promise<StoredWindow[]> {
  const rows = await client.accessTokenUsageWindow.findMany({ where: { accessTokenId: tokenId } })
  return rows.flatMap((row) => {
    const window = UsageWindowSchema.safeParse(row.window)
    return window.success
      ? [{ window: window.data, startedAt: row.startedAt, requests: row.requests, costUsd: row.costUsd }]
      : []
  })
}

/** Which limit a full window has reached. */
export type ExhaustedBy = 'requests' | 'spend'

export type Admission =
  | { outcome: 'allowed' }
  | { outcome: 'exhausted'; window: UsageWindow; by: ExhaustedBy; resetsAt: string; retryAfterSeconds: number }
  | { outcome: 'unavailable' }

interface Exhaustion {
  window: UsageWindow
  by: ExhaustedBy
  resetsAt: Dayjs
}

/** What stops an open window from admitting one more request, or null. */
function exhaustionOf(row: StoredWindow, limit: WindowLimit, now: Dayjs): Exhaustion | null {
  if (!isOpen(row.window, row.startedAt, now)) return null
  const resetsAt = resetOf(row.window, row.startedAt)
  if (limit.requests !== null && row.requests >= limit.requests) return { window: row.window, by: 'requests', resetsAt }
  if (limit.spendUsd !== null && row.costUsd >= limit.spendUsd) return { window: row.window, by: 'spend', resetsAt }
  return null
}

// A namespace for pg_advisory_xact_lock's two-key form, so this lock can
// never collide with one taken on the same hash for some other purpose.
const ADMISSION_LOCK_NAMESPACE = 0x52_57_49_4e

async function lockTokenWindows(client: Pick<ReturnType<typeof getPrismaClient>, '$queryRaw'>, tokenId: string) {
  await client.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(${ADMISSION_LOCK_NAMESPACE}::bigint)`
  await client.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}::int, hashtext(${tokenId}))`
}

/**
 * Check a token's windows and, when neither is full, count one request in
 * both (opening or restarting whichever is not current).
 *
 * Serialised per token by a transaction-scoped advisory lock. A row lock
 * alone is not enough: before a window exists there is no row to lock,
 * so two requests racing to open one — or to restart one at the instant
 * it expires — could each read "empty" and both be admitted past a limit.
 * Under the lock the check and the count are one step, so N concurrent
 * requests against a limit of L admit exactly L. Refusals write nothing,
 * so a client hammering a full window does not inflate its count.
 *
 * Fails closed: a ledger that cannot be written refuses ('unavailable'),
 * because the limits are the only thing bounding what a token may spend.
 */
export async function admitRequest(tokenId: string, limits: PlanLimits): Promise<Admission> {
  try {
    return await getPrismaClient().$transaction(async (tx): Promise<Admission> => {
      await lockTokenWindows(tx, tokenId)
      const now = dayjs()
      const rows = await storedWindows(tx, tokenId)

      // When both windows are full the client has to wait for the later
      // reset, so that is the one the refusal names.
      const full = rows
        .map((row) => exhaustionOf(row, limits[row.window], now))
        .filter((exhaustion): exhaustion is Exhaustion => exhaustion !== null)
        .sort((first, second) => second.resetsAt.valueOf() - first.resetsAt.valueOf())
      if (full.length > 0) {
        const first = full[0]
        return {
          outcome: 'exhausted',
          window: first.window,
          by: first.by,
          resetsAt: first.resetsAt.toISOString(),
          retryAfterSeconds: Math.max(1, Math.ceil(first.resetsAt.diff(now) / 1000))
        }
      }

      for (const window of USAGE_WINDOWS) {
        const row = rows.find((stored) => stored.window === window)
        const open = row !== undefined && isOpen(window, row.startedAt, now)
        const fresh = { startedAt: now.toDate(), requests: 1, costUsd: 0 }
        await tx.accessTokenUsageWindow.upsert({
          where: { accessTokenId_window: { accessTokenId: tokenId, window } },
          create: { accessTokenId: tokenId, window, ...fresh },
          // An expired row is restarted, not added to: its requests and
          // spend belong to a window that is over.
          update: open ? { requests: { increment: 1 } } : fresh
        })
      }
      return { outcome: 'allowed' }
    })
  } catch {
    return { outcome: 'unavailable' }
  }
}

/**
 * Add a priced cost to the token's current windows.
 *
 * Only windows still open at `now` take it. An increment rather than a
 * read-modify-write. Both increments share the admission and reset locks
 * so the two windows cannot straddle a reset.
 */
export async function addSpend(tokenId: string, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  await getPrismaClient().$transaction(async (tx) => {
    await lockTokenWindows(tx, tokenId)
    const now = dayjs()
    for (const window of USAGE_WINDOWS) {
      await tx.accessTokenUsageWindow.updateMany({
        where: {
          accessTokenId: tokenId,
          window,
          startedAt: { gt: now.subtract(WINDOW_HOURS[window], 'hour').toDate() }
        },
        data: { costUsd: { increment: costUsd } }
      })
    }
  })
}

/** What a completed call used, in the shape `computeCosts` prices. */
export interface CallUsage {
  accessTokenId: string | null
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

/**
 * Price a completed call the way the token's Cost column does and add it
 * to its open windows.
 *
 * Looks for an open window before pricing, so a token with none — no
 * plan, a plan with no limits, or a window that has lapsed — costs one
 * primary-key read and no price lookup. Never throws: spend accounting is
 * not a reason to disturb the response it follows.
 */
export async function recordCallSpend(usage: CallUsage): Promise<void> {
  const tokenId = usage.accessTokenId
  if (tokenId === null) return
  try {
    const now = dayjs()
    const rows = await storedWindows(getPrismaClient(), tokenId)
    if (!rows.some((row) => isOpen(row.window, row.startedAt, now))) return
    const priceMap = await buildPriceMap(getPrismaClient(), [`${usage.provider}||${usage.model}`])
    const cost = computeCosts(usage, priceMap).totalCostUsd
    if (cost === null) return
    await addSpend(tokenId, cost)
  } catch {
    // A missed increment under-counts one call; failing here would lose
    // the response the caller already has.
  }
}

/** One window as the admin page and the Codex MCP status tool report it. */
export interface WindowReport {
  window: UsageWindow
  /** Null while no window is open: nothing has been counted since the last one ended. */
  startedAt: string | null
  resetsAt: string | null
  requests: number
  requestLimit: number | null
  costUsd: number
  spendLimitUsd: number | null
}

/** Both windows for a token, as they stand now. A lapsed window reads as empty. */
export async function readUsageWindows(tokenId: string, limits: PlanLimits | null): Promise<WindowReport[]> {
  const now = dayjs()
  const rows = limits === null || !hasAnyLimit(limits) ? [] : await storedWindows(getPrismaClient(), tokenId)
  return USAGE_WINDOWS.map((window) => {
    const row = rows.find((stored) => stored.window === window)
    const open = row !== undefined && isOpen(window, row.startedAt, now)
    const limit = limits === null ? { requests: null, spendUsd: null } : limits[window]
    return {
      window,
      startedAt: open ? row.startedAt.toISOString() : null,
      resetsAt: open ? resetOf(window, row.startedAt).toISOString() : null,
      requests: open ? row.requests : 0,
      requestLimit: limit.requests,
      costUsd: open ? row.costUsd : 0,
      spendLimitUsd: limit.spendUsd
    }
  })
}

/**
 * Forget a token's windows, or every token's. The next request opens
 * fresh ones. Returns how many rows went.
 */
export async function resetUsageWindows(tokenId: string | null): Promise<number> {
  return getPrismaClient().$transaction(async (tx) => {
    if (tokenId === null) {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}::bigint)`
    } else {
      await lockTokenWindows(tx, tokenId)
    }
    const { count } = await tx.accessTokenUsageWindow.deleteMany({
      where: tokenId === null ? {} : { accessTokenId: tokenId }
    })
    return count
  })
}

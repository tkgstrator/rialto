/**
 * What each subscription account carried, priced as if it were API traffic.
 *
 * A subscription has no per-token price, so nothing here is a bill: the
 * figure is what the same tokens would have cost at the model's API price
 * (`buildPriceMap` falls back to the same model name on a priced provider).
 * That is the number an operator with several accounts wants — which plan
 * earns its fee — and it only became answerable once RequestLog recorded
 * the account that served each request (`subAccountId`).
 *
 * Two spans per account:
 *   - the weekly window the account is in now, as its vendor meters it
 *     (`SubAccountQuota.weeklyResetAt` minus the window length), so the
 *     tokens sit next to the percentage bar they explain;
 *   - the last 30 days, set against the plan's monthly price.
 *
 * Aggregated the way `access-token-service` does it: group by (provider,
 * model) in the database, price each group once, add in memory.
 * `computeCosts` is linear in the token counts, so that is exact.
 */

import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { buildPriceMap, computeCosts, type PriceEntry } from './cost-service'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MONTH_DAYS = 30

export interface UsageFigures {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  // Everything the prompts and replies moved, cache included — the one
  // number the tokens column shows.
  totalTokens: number
  // Null when traffic exists but none of it could be priced; 0 when there
  // was no traffic. The two are different answers and the UI says which.
  costUsd: number | null
}

export interface AccountUsage {
  // When the current weekly window began (ISO), so the UI can say "since".
  windowStart: string
  window: UsageFigures
  last30d: UsageFigures
  // 30-day API-equivalent cost over the plan's monthly price. Null when
  // either side is unknown.
  valueRatio: number | null
}

export interface AccountUsageInput {
  subAccountId: string
  weeklyResetAt: Date | null
  weeklyWindowSeconds: number | null
  monthlyPriceUsd: number | null
}

/**
 * Start of the weekly window the account is in now.
 *
 * The collector records when the window resets and, for Codex, how long it
 * is; Claude's is a fixed week. A reset time already in the past means the
 * window it closed is over and a new one began then — the row is merely
 * older than the reset — so that instant is the start. With no reading at
 * all, the trailing week stands in.
 */
export function weeklyWindowStart(account: AccountUsageInput, now: number): number {
  if (account.weeklyResetAt === null) return now - WEEK_MS
  const resetAt = account.weeklyResetAt.valueOf()
  if (resetAt <= now) return resetAt
  const length = account.weeklyWindowSeconds === null ? WEEK_MS : account.weeklyWindowSeconds * 1000
  return resetAt - length
}

interface ModelGroup {
  subAccountId: string
  provider: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

const orZero = (value: number | null): number => (value === null ? 0 : value)

// The one groupBy shape both spans use. `subAccountId` is part of the key
// so a single query can serve every account.
async function groupsFor(prisma: PrismaClient, subAccountIds: string[], since: Date): Promise<ModelGroup[]> {
  const rows = await prisma.requestLog.groupBy({
    by: ['subAccountId', 'provider', 'model'],
    where: { subAccountId: { in: subAccountIds }, createdAt: { gte: since } },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      cacheWrite1hTokens: true
    },
    _count: { _all: true }
  })
  return rows.flatMap((row) =>
    row.subAccountId === null
      ? []
      : [
          {
            subAccountId: row.subAccountId,
            provider: row.provider,
            model: row.model,
            requests: row._count._all,
            inputTokens: orZero(row._sum.inputTokens),
            outputTokens: orZero(row._sum.outputTokens),
            cacheReadTokens: orZero(row._sum.cacheReadTokens),
            cacheWriteTokens: orZero(row._sum.cacheWriteTokens),
            cacheWrite1hTokens: orZero(row._sum.cacheWrite1hTokens)
          }
        ]
  )
}

/** Add up one account's groups and price them. Pure, so it is tested on its own. */
export function figuresOf(groups: readonly ModelGroup[], priceMap: Map<string, PriceEntry>): UsageFigures {
  const sum = (pick: (g: ModelGroup) => number): number => groups.reduce((total, g) => total + pick(g), 0)
  const inputTokens = sum((g) => g.inputTokens)
  const outputTokens = sum((g) => g.outputTokens)
  const cacheReadTokens = sum((g) => g.cacheReadTokens)
  const cacheWriteTokens = sum((g) => g.cacheWriteTokens)
  const priced = groups
    .map((g) => computeCosts(g, priceMap).totalCostUsd)
    .filter((cost): cost is number => cost !== null)
  // A model with no price anywhere contributes nothing rather than
  // voiding the account's figure: the part that priced is still real. Only
  // when nothing priced at all is the answer "unknown".
  const costUsd = priced.length > 0 ? priced.reduce((a, b) => a + b, 0) : groups.length === 0 ? 0 : null
  return {
    requests: sum((g) => g.requests),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd
  }
}

/** The 30-day cost over the monthly fee, when both are known and the fee is not zero. */
export function valueRatioOf(costUsd: number | null, monthlyPriceUsd: number | null): number | null {
  if (costUsd === null || monthlyPriceUsd === null || monthlyPriceUsd <= 0) return null
  return costUsd / monthlyPriceUsd
}

/**
 * Usage per account, keyed by subAccountId.
 *
 * One grouped query covers every account's 30 days. The weekly window
 * starts at a different instant for each account, so each gets its own
 * query for that span — a handful of accounts, each a small aggregate on
 * the `createdAt` index. Prices are looked up once for every pair seen.
 */
export async function usageByAccount(
  accounts: readonly AccountUsageInput[],
  now: number = dayjs().valueOf(),
  prisma: PrismaClient = getPrismaClient()
): Promise<Map<string, AccountUsage>> {
  if (accounts.length === 0) return new Map()
  const ids = accounts.map((a) => a.subAccountId)
  const monthSince = dayjs(now).subtract(MONTH_DAYS, 'day').toDate()
  const starts = new Map(accounts.map((a) => [a.subAccountId, weeklyWindowStart(a, now)]))

  const [month, ...weeks] = await Promise.all([
    groupsFor(prisma, ids, monthSince),
    ...accounts.map((a) => groupsFor(prisma, [a.subAccountId], dayjs(weeklyWindowStart(a, now)).toDate()))
  ])
  const week = weeks.flat()
  const pairs = [...new Set([...month, ...week].map((g) => `${g.provider}||${g.model}`))]
  const priceMap = await buildPriceMap(prisma, pairs)

  const out = new Map<string, AccountUsage>()
  for (const account of accounts) {
    const last30d = figuresOf(
      month.filter((g) => g.subAccountId === account.subAccountId),
      priceMap
    )
    const start = starts.get(account.subAccountId)
    out.set(account.subAccountId, {
      windowStart: dayjs(start === undefined ? now - WEEK_MS : start).toISOString(),
      window: figuresOf(
        week.filter((g) => g.subAccountId === account.subAccountId),
        priceMap
      ),
      last30d,
      valueRatio: valueRatioOf(last30d.costUsd, account.monthlyPriceUsd)
    })
  }
  return out
}

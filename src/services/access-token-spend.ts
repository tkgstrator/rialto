import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { buildPriceMap, computeCosts, type PriceEntry } from './cost-service'

export const SPEND_WINDOW_DAYS = 30

/**
 * One aggregated (token, provider, model) row's worth of usage.
 *
 * Grouped in Postgres before pricing rather than priced per request:
 * `computeCosts` is linear in the token counts, so summing the counts
 * first and pricing once is exact, not an approximation — the same
 * reasoning `overview-service` documents for its spend window.
 */
export interface TokenSpendGroup {
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
 * Total USD per access token, or null for a token whose traffic could
 * not be priced at all.
 *
 * Null and 0 are different answers and both happen: a subscription
 * provider has no per-token price, so its groups price to null and the
 * column shows "unpriced" rather than "free". A token that priced some
 * of its models and not others reports the part that priced — an
 * under-count, but the alternative is discarding a real number.
 */
export function sumSpendByToken(
  groups: readonly TokenSpendGroup[],
  priceMap: Map<string, PriceEntry>
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const group of groups) {
    if (group.accessTokenId === null) continue
    const cost = computeCosts(group, priceMap).totalCostUsd
    if (cost === null) continue
    const running = totals.get(group.accessTokenId)
    totals.set(group.accessTokenId, running === undefined ? cost : running + cost)
  }
  return totals
}

/**
 * What one token's traffic did over the trailing window.
 *
 * Cost and token counts are carried together because they come out of
 * one scan, but their nulls do not line up: a subscription model logs
 * token counts and prices to null, so a row can have real counts and no
 * cost. Splitting them into two maps and joining on presence would have
 * lost that distinction.
 */
export interface TokenWindowTotals {
  costUsd: number | null
  inputTokens: number
  outputTokens: number
}

/**
 * Input / output totals per access token.
 *
 * Unlike the spend sum this discards nothing: a group with no price
 * still moved tokens, and that is the number being asked for. Cache
 * reads and writes are deliberately not folded in — they are priced
 * separately and adding them into `inputTokens` would double-count
 * against the cost column sitting next to it.
 */
export function sumTokensByToken(
  groups: readonly TokenSpendGroup[]
): Map<string, { inputTokens: number; outputTokens: number }> {
  const totals = new Map<string, { inputTokens: number; outputTokens: number }>()
  for (const group of groups) {
    if (group.accessTokenId === null) continue
    const running = totals.get(group.accessTokenId)
    if (running === undefined) {
      totals.set(group.accessTokenId, { inputTokens: group.inputTokens, outputTokens: group.outputTokens })
      continue
    }
    running.inputTokens += group.inputTokens
    running.outputTokens += group.outputTokens
  }
  return totals
}

// Per-token usage over the trailing window. Two queries regardless of
// how many tokens exist: one grouped scan of the window, one price
// lookup for the distinct models it touched.
//
// `onlyId` narrows the scan to one token for the detail screen. The
// grouping and the pricing are otherwise identical, so a token's cost
// cannot read one way in the table and another on its own page.
export async function spendByToken(onlyId?: string): Promise<Map<string, TokenWindowTotals>> {
  const since = dayjs().subtract(SPEND_WINDOW_DAYS, 'day').toDate()
  const groups = await getPrismaClient().requestLog.groupBy({
    by: ['accessTokenId', 'provider', 'model'],
    where: {
      accessTokenId: onlyId === undefined ? { not: null } : onlyId,
      createdAt: { gte: since }
    },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      cacheWrite1hTokens: true
    }
  })
  if (groups.length === 0) return new Map()
  const rows: TokenSpendGroup[] = groups.map((g) => ({
    accessTokenId: g.accessTokenId,
    provider: g.provider,
    model: g.model,
    inputTokens: g._sum.inputTokens === null ? 0 : g._sum.inputTokens,
    outputTokens: g._sum.outputTokens === null ? 0 : g._sum.outputTokens,
    cacheReadTokens: g._sum.cacheReadTokens === null ? 0 : g._sum.cacheReadTokens,
    cacheWriteTokens: g._sum.cacheWriteTokens === null ? 0 : g._sum.cacheWriteTokens,
    cacheWrite1hTokens: g._sum.cacheWrite1hTokens === null ? 0 : g._sum.cacheWrite1hTokens
  }))
  const priceMap = await buildPriceMap(getPrismaClient(), [...new Set(rows.map((r) => `${r.provider}||${r.model}`))])
  const spend = sumSpendByToken(rows, priceMap)
  const tokens = sumTokensByToken(rows)
  const totals = new Map<string, TokenWindowTotals>()
  // Keyed off the token sums, not the spend sums: every token with rows
  // in the window belongs in the map, including the ones whose traffic
  // priced to null.
  for (const [id, counts] of tokens) {
    const cost = spend.get(id)
    totals.set(id, { costUsd: cost === undefined ? null : cost, ...counts })
  }
  return totals
}

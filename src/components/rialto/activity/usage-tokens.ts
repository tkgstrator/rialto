import type { AccessTokenWire } from '@/lib/api'

export interface TokenUsageRow {
  id: string
  name: string
  prefix: string
  surfaces: string[]
  requestCount: number
  costUsd: number | null
  /** Share of the priced total, 0-100. Null when nothing priced. */
  sharePct: number | null
  lastUsedAt: string | null
}

/**
 * Token rows ordered by spend, with each one's share of the priced total.
 *
 * The share denominator is the sum of the tokens that HAVE a price, not
 * of every token: subscription traffic prices to null, and folding those
 * in as zero would quietly report a share of a total that does not exist.
 * A token with no priced traffic gets a null share and renders as a dash,
 * the same answer its cost cell gives.
 *
 * Revoked tokens are kept. Their traffic is part of what the window cost,
 * and dropping them makes the shares of the survivors add up to more than
 * the money actually spent.
 */
export function tokenUsageRows(tokens: readonly AccessTokenWire[]): TokenUsageRow[] {
  const total = tokens.reduce((sum, token) => (token.costUsd === null ? sum : sum + token.costUsd), 0)
  return tokens
    .map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      surfaces: token.surfaces,
      requestCount: token.requestCount,
      costUsd: token.costUsd,
      sharePct: token.costUsd === null || total <= 0 ? null : Math.round((token.costUsd / total) * 100),
      lastUsedAt: token.lastUsedAt
    }))
    .sort((a, b) => {
      // Unpriced tokens sort last rather than as $0 — they are unknown,
      // not free, and parking them mid-table reads as "cheaper than".
      if (a.costUsd === null && b.costUsd === null) return b.requestCount - a.requestCount
      if (a.costUsd === null) return 1
      if (b.costUsd === null) return -1
      return b.costUsd - a.costUsd
    })
}

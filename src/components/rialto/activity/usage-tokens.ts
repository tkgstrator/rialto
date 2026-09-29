import type { AccessTokenWire, RevokedTokensWire } from '@/lib/api'

export interface TokenUsageRow {
  /**
   * A listed token, or the one line standing for every revoked token's
   * traffic in the window (revoking deletes the token, so it has no row
   * of its own). The revoked line has no name, prefix, scope or last use.
   */
  kind: 'token' | 'revoked'
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
 * Revoked tokens' traffic is kept, as one line at the bottom. It is part
 * of what the window cost, and dropping it would make the shares of the
 * survivors add up to more than the money actually spent.
 */
export function tokenUsageRows(tokens: readonly AccessTokenWire[], revoked: RevokedTokensWire | null): TokenUsageRow[] {
  const priced = [...tokens.map((token) => token.costUsd), revoked === null ? null : revoked.costUsd]
  const total = priced.reduce<number>((sum, cost) => (cost === null ? sum : sum + cost), 0)
  const shareOf = (cost: number | null) => (cost === null || total <= 0 ? null : Math.round((cost / total) * 100))
  const listed = tokens
    .map((token) => ({
      kind: 'token' as const,
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      surfaces: token.surfaces,
      requestCount: token.requestCount,
      costUsd: token.costUsd,
      sharePct: shareOf(token.costUsd),
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
  if (revoked === null) return listed
  return [
    ...listed,
    {
      kind: 'revoked',
      id: 'revoked',
      name: '',
      prefix: '',
      surfaces: [],
      requestCount: revoked.requestCount,
      costUsd: revoked.costUsd,
      sharePct: shareOf(revoked.costUsd),
      lastUsedAt: null
    }
  ]
}

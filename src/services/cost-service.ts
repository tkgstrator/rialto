import type { getPrismaClient } from '../db/client'

export type PriceEntry = {
  inputPer1M: number | null
  outputPer1M: number | null
  cachedInputPer1M: number | null
}

export async function buildPriceMap(
  prisma: ReturnType<typeof getPrismaClient>,
  pairs: string[]
): Promise<Map<string, PriceEntry>> {
  if (pairs.length === 0) return new Map()

  const modelNames = [...new Set(pairs.map((p) => p.slice(p.indexOf('||') + 2)))]

  const rows = await prisma.model.findMany({
    where: {
      OR: [
        ...pairs.map((p) => {
          const sep = p.indexOf('||')
          return { name: p.slice(sep + 2), provider: { name: p.slice(0, sep) } }
        }),
        { name: { in: modelNames }, inputPer1M: { not: null } }
      ]
    },
    select: {
      name: true,
      inputPer1M: true,
      outputPer1M: true,
      cachedInputPer1M: true,
      provider: { select: { name: true } }
    }
  })

  const map = new Map<string, PriceEntry>()
  const fallback = new Map<string, PriceEntry>()
  for (const m of rows) {
    map.set(`${m.provider.name}||${m.name}`, m)
    if (m.inputPer1M != null && !fallback.has(m.name)) fallback.set(m.name, m)
  }

  for (const pair of pairs) {
    const existing = map.get(pair)
    if (!existing || existing.inputPer1M == null) {
      const modelName = pair.slice(pair.indexOf('||') + 2)
      const fb = fallback.get(modelName)
      if (fb) map.set(pair, fb)
    }
  }

  return map
}

// Cache-write price multipliers over the input price, per Anthropic's
// published prompt-caching rates.
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

export function computeCosts(
  log: {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    // The 1-hour-TTL share of cacheWriteTokens. Required, so a caller
    // that sums the columns cannot forget this one and silently price
    // every 1h write at the 5-minute rate.
    cacheWrite1hTokens: number
  },
  priceMap: Map<string, PriceEntry>
) {
  const price = priceMap.get(`${log.provider}||${log.model}`)
  const inputCostUsd = price?.inputPer1M != null ? (log.inputTokens / 1_000_000) * price.inputPer1M : null
  const outputCostUsd = price?.outputPer1M != null ? (log.outputTokens / 1_000_000) * price.outputPer1M : null
  const cacheReadCostUsd =
    price?.cachedInputPer1M != null ? (log.cacheReadTokens / 1_000_000) * price.cachedInputPer1M : null
  // Anthropic prices a cache write by its TTL: 1.25x input for 5 minutes,
  // 2x for an hour. Vendors that report no split leave write1h at 0, so
  // every write keeps the 5-minute rate as before.
  const write1h = Math.min(log.cacheWrite1hTokens, log.cacheWriteTokens)
  const write5m = log.cacheWriteTokens - write1h
  const cacheWriteCostUsd =
    price?.inputPer1M != null
      ? ((write5m * CACHE_WRITE_5M + write1h * CACHE_WRITE_1H) / 1_000_000) * price.inputPer1M
      : null
  const totalCostUsd =
    inputCostUsd != null && outputCostUsd != null
      ? inputCostUsd + outputCostUsd + (cacheReadCostUsd ?? 0) + (cacheWriteCostUsd ?? 0)
      : null
  return { inputCostUsd, outputCostUsd, cacheReadCostUsd, totalCostUsd }
}

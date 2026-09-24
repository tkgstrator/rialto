import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getPrismaClient } from '../../../../db/client'
import dayjs from '../../../../lib/dayjs'
import { buildPriceMap, computeCosts } from '../../../../services/cost-service'

const CostHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(0).default(30)
})

const CostHistoryResponseSchema = z.object({
  points: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  providers: z.array(z.string()),
  granularity: z.enum(['day', 'week']),
  days: z.number().int()
})

interface RawLogRow {
  bucket: Date
  provider: string
  model: string
  input_tokens: bigint
  output_tokens: bigint
  cache_read_tokens: bigint
  cache_write_tokens: bigint
  cache_write_1h_tokens: bigint
}

export const usageCostHistoryRoute = new OpenAPIHono()

usageCostHistoryRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/usage/cost/history',
    request: { query: CostHistoryQuerySchema },
    responses: {
      200: {
        description: 'API cost per provider aggregated by day (≤30d) or week (All) from RequestLog.',
        content: { 'application/json': { schema: CostHistoryResponseSchema } }
      }
    }
  }),
  async (c) => {
    const { days } = c.req.valid('query')
    const prisma = getPrismaClient()
    const since = days > 0 ? dayjs().subtract(days, 'day').toDate() : null
    // Use weekly buckets for "All" to keep the bar count manageable.
    const granularity: 'day' | 'week' = days === 0 ? 'week' : 'day'
    const trunc = granularity === 'week' ? 'week' : 'day'

    const rows: RawLogRow[] = since
      ? await prisma.$queryRaw`
          SELECT DATE_TRUNC(${trunc}, "createdAt") AS bucket, provider, model,
                 SUM("inputTokens") AS input_tokens, SUM("outputTokens") AS output_tokens,
                 SUM("cacheReadTokens") AS cache_read_tokens, SUM("cacheWriteTokens") AS cache_write_tokens,
                 SUM("cacheWrite1hTokens") AS cache_write_1h_tokens
          FROM "RequestLog"
          WHERE "createdAt" >= ${since}
          GROUP BY bucket, provider, model
          ORDER BY bucket, provider`
      : await prisma.$queryRaw`
          SELECT DATE_TRUNC(${trunc}, "createdAt") AS bucket, provider, model,
                 SUM("inputTokens") AS input_tokens, SUM("outputTokens") AS output_tokens,
                 SUM("cacheReadTokens") AS cache_read_tokens, SUM("cacheWriteTokens") AS cache_write_tokens,
                 SUM("cacheWrite1hTokens") AS cache_write_1h_tokens
          FROM "RequestLog"
          GROUP BY bucket, provider, model
          ORDER BY bucket, provider`

    // Every day in the window gets a point (day granularity) so the chart
    // always renders `days` bars, with empty days as 0 — instead of a few
    // very wide bars when only a day or two has data.
    const windowDates =
      granularity === 'day' && days > 0
        ? Array.from({ length: days }, (_, k) => dayjs().subtract(k, 'day').format('YYYY-MM-DD'))
        : []

    if (rows.length === 0) {
      return c.json({ points: windowDates.map((date) => ({ date })), providers: [], granularity, days }, 200)
    }

    const pairs = [...new Set(rows.map((r) => `${r.provider}||${r.model}`))]
    const priceMap = await buildPriceMap(prisma, pairs)

    const byBucketProvider = new Map<string, Map<string, number>>()
    const providerSet = new Set<string>()

    for (const r of rows) {
      const dateKey = dayjs(r.bucket).format('YYYY-MM-DD')
      const { totalCostUsd } = computeCosts(
        {
          provider: r.provider,
          model: r.model,
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          cacheReadTokens: Number(r.cache_read_tokens),
          cacheWriteTokens: Number(r.cache_write_tokens),
          cacheWrite1hTokens: Number(r.cache_write_1h_tokens)
        },
        priceMap
      )
      if (totalCostUsd == null) continue

      providerSet.add(r.provider)
      if (!byBucketProvider.has(dateKey)) byBucketProvider.set(dateKey, new Map())
      const providerMap = byBucketProvider.get(dateKey)!
      providerMap.set(r.provider, (providerMap.get(r.provider) ?? 0) + totalCostUsd)
    }

    // Backfill empty days so every day in the window is represented.
    for (const date of windowDates) {
      if (!byBucketProvider.has(date)) byBucketProvider.set(date, new Map())
    }

    const providers = [...providerSet].sort()
    const points = [...byBucketProvider.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, providerMap]) => {
        const point: Record<string, string | number> = { date }
        for (const p of providers) {
          const v = providerMap.get(p)
          if (v != null) point[p] = Math.round(v * 100) / 100
        }
        return point
      })

    return c.json({ points, providers, granularity, days }, 200)
  }
)

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getPrismaClient } from '../../../db/client'
import { AuthMode } from '../../../generated/prisma/client'
import dayjs from '../../../lib/dayjs'
import { buildPriceMap, computeCosts } from '../../../services/cost-service'

const ModelCostSchema = z.object({
  model: z.string(),
  requestCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  totalCostUsd: z.number().nullable()
})

const ProviderCostSchema = z.object({
  provider: z.string(),
  models: z.array(ModelCostSchema),
  totalCostUsd: z.number().nullable(),
  // True when the provider uses subscription auth (not api_key).
  isSubscription: z.boolean(),
  // Monthly subscription price for enabled accounts on this provider.
  // Null for api_key providers or when no price has been synced yet.
  subscriptionMonthlyUsd: z.number().nullable()
})

const UsageCostResponseSchema = z.object({
  providers: z.array(ProviderCostSchema),
  days: z.number().int()
})

const UsageCostQuerySchema = z.object({
  days: z.coerce.number().int().min(0).default(30)
})

export const usageCostRoute = new OpenAPIHono()

usageCostRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/usage/cost',
    request: { query: UsageCostQuerySchema },
    responses: {
      200: {
        description: 'Per-provider/model token and estimated cost aggregates from RequestLog.',
        content: { 'application/json': { schema: UsageCostResponseSchema } }
      }
    }
  }),
  async (c) => {
    const { days } = c.req.valid('query')
    const prisma = getPrismaClient()
    const since = days > 0 ? dayjs().subtract(days, 'day').toDate() : undefined

    const groups = await prisma.requestLog.groupBy({
      by: ['provider', 'model'],
      where: since ? { createdAt: { gte: since } } : {},
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        cacheWrite1hTokens: true
      },
      _count: { id: true },
      orderBy: [{ provider: 'asc' }, { model: 'asc' }]
    })

    if (groups.length === 0) return c.json({ providers: [], days }, 200)

    const pairs = groups.map((g) => `${g.provider}||${g.model}`)
    const priceMap = await buildPriceMap(prisma, pairs)

    // Build per-provider subscription monthly price map from enabled SubAccounts.
    const subProviders = await prisma.provider.findMany({
      where: { authMode: AuthMode.subscription },
      select: {
        name: true,
        subscriptionAccounts: {
          where: { enabled: true, monthlyPriceUsd: { not: null } },
          select: { monthlyPriceUsd: true }
        }
      }
    })
    const subMonthlyMap = new Map<string, number | null>()
    for (const p of subProviders) {
      const total = p.subscriptionAccounts.reduce<number | null>((sum, a) => {
        if (a.monthlyPriceUsd == null) return sum
        return (sum ?? 0) + a.monthlyPriceUsd
      }, null)
      subMonthlyMap.set(p.name, total)
    }

    const byProvider = new Map<string, typeof groups>()
    for (const g of groups) {
      if (!byProvider.has(g.provider)) byProvider.set(g.provider, [])
      byProvider.get(g.provider)!.push(g)
    }

    const providers = [...byProvider.entries()].map(([provider, modelGroups]) => {
      let providerTotal: number | null = null
      const models = modelGroups.map((g) => {
        const inputTokens = g._sum.inputTokens ?? 0
        const outputTokens = g._sum.outputTokens ?? 0
        const cacheReadTokens = g._sum.cacheReadTokens ?? 0
        const cacheWriteTokens = g._sum.cacheWriteTokens ?? 0
        const cacheWrite1hTokens = g._sum.cacheWrite1hTokens === null ? 0 : g._sum.cacheWrite1hTokens
        const { totalCostUsd } = computeCosts(
          {
            provider: g.provider,
            model: g.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cacheWrite1hTokens
          },
          priceMap
        )
        if (totalCostUsd != null) providerTotal = (providerTotal ?? 0) + totalCostUsd
        return {
          model: g.model,
          requestCount: g._count.id,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalCostUsd
        }
      })
      const isSubscription = subMonthlyMap.has(provider)
      const subscriptionMonthlyUsd = isSubscription ? (subMonthlyMap.get(provider) ?? null) : null
      return { provider, models, totalCostUsd: providerTotal, isSubscription, subscriptionMonthlyUsd }
    })

    return c.json({ providers, days }, 200)
  }
)

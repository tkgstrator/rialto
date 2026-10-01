/**
 * GET /v1/models — OpenAI-compat catalog surface.
 *
 * OpenAI SDK / Cline / OpenWebUI probe this on init to build the model
 * dropdown; without it the SDK errors before making any inference call.
 * We serve the same DB-backed enabled-model list `/api/models` returns,
 * reshaped into OpenAI's `{object:'list', data:[{id, object, created,
 * owned_by}]}` envelope. `id` is always the native bare model name;
 * Rialto chooses the provider from its configured priority when needed.
 * A duplicate name with no preference is not listed as callable.
 *
 * The list only includes models the router can actually reach right now
 * (auth resolved + provider enabled), mirroring what the Router selects
 * see — so a listed id is guaranteed routable at that moment.
 *
 * Beyond OpenAI's four fields, each entry carries what an app that bills
 * its own users needs to price a call without a second source: the
 * provider and the bare model name (a response's `model` is the bare
 * name), the context window, and the price in USD per million tokens —
 * the same figures, fallback included, that Rialto's own cost columns
 * use (`buildPriceMap`). SDKs ignore fields they do not know.
 */

import { Hono } from 'hono'
import '../context'
import { getPrismaClient } from '../../db/client'
import { getEnabledModels } from '../../services/config'
import { buildPriceMap, CACHE_WRITE_1H, CACHE_WRITE_5M, type PriceEntry } from '../../services/cost-service'
import { resolvePreferredProvider } from '../../services/model-provider-preference'
import { publicModelId, qualifiedModelId } from '../../shared/public-model-id'

export const v1ModelsRoute = new Hono()

// A price is published only whole: input and output are what every call
// spends, and a half-known price would be read as a cheap one.
function pricingOf(price: PriceEntry | undefined) {
  if (price === undefined || price.inputPer1M === null || price.outputPer1M === null) return null
  return {
    unit: 'usd_per_1m_tokens',
    input: price.inputPer1M,
    output: price.outputPer1M,
    cached_input: price.cachedInputPer1M,
    cache_write_5m: price.inputPer1M * CACHE_WRITE_5M,
    cache_write_1h: price.inputPer1M * CACHE_WRITE_1H
  }
}

v1ModelsRoute.get('/v1/models', async (c) => {
  const [chatModels, imageModels] = await Promise.all([getEnabledModels(), getEnabledModels(undefined, 'image')])
  // A token on a plan sees only the models its plan allows: listing one it
  // cannot spend would invite a request the plan then quietly reroutes to
  // its default.
  const plan = c.get('accessToken')?.plan
  const eligible = [...chatModels, ...imageModels].filter(
    (m) => plan === null || plan === undefined || plan.models.includes(qualifiedModelId(m))
  )
  const names = [...new Set(eligible.map((m) => m.model))]
  const selected = await Promise.all(
    names.map(async (name) => {
      const candidates = eligible.filter((m) => m.model === name)
      const resolution = await resolvePreferredProvider(
        name,
        candidates.map((m) => m.provider)
      )
      return resolution.status === 'preferred' ? candidates.find((m) => m.provider === resolution.provider) : undefined
    })
  )
  const models = selected.filter((m): m is (typeof eligible)[number] => m !== undefined)
  // OpenAI uses seconds-since-epoch for `created`; the value carries no
  // real meaning here (there is no per-model creation time in Rialto), so
  // stamp the response time uniformly. SDKs that render "last modified"
  // will see all models as freshly listed.
  const now = Math.floor(Date.now() / 1000)
  const prisma = getPrismaClient()
  const pairs = models.map((m) => `${m.provider}||${m.model}`)
  const [prices, windows] = await Promise.all([
    buildPriceMap(prisma, pairs),
    prisma.model.findMany({
      where: { OR: models.map((m) => ({ name: m.model, provider: { name: m.provider } })) },
      select: { name: true, contextWindow: true, provider: { select: { name: true } } }
    })
  ])
  const windowOf = new Map(windows.map((w) => [`${w.provider.name}||${w.name}`, w.contextWindow]))
  const contextWindow = (key: string) => {
    const known = windowOf.get(key)
    return known === undefined ? null : known
  }
  return c.json({
    object: 'list',
    data: models.map((m) => ({
      id: publicModelId(m),
      object: 'model',
      created: now,
      owned_by: m.provider,
      provider: m.provider,
      model: m.model,
      context_window: contextWindow(`${m.provider}||${m.model}`),
      pricing: pricingOf(prices.get(`${m.provider}||${m.model}`))
    }))
  })
})

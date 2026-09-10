/**
 * Load the scraped official vendor prices
 * (src/shared/data/providers/<vendor>/prices.json, surfaced as
 * OFFICIAL_VENDOR_PRICES) into the Model table for the three
 * first-party API vendors.
 *
 * Behaviour: for each of openai / anthropic / google (api_key auth
 * only), the Model catalog is reconciled to exactly the scraped set —
 * models the scrape no longer lists are deleted (any chain entry naming
 * one cascades away, and is logged), and every scraped model is
 * upserted with its USD/1M input+output price, `deprecated` (from the
 * deprecations registry) and `legacy` (from the scrape) flags.
 *
 * Subscription providers (claude-code / codex, authMode=subscription)
 * are intentionally untouched — their pricing is plan-based, not
 * per-token, and the user manages those separately.
 */

import type { z } from '@hono/zod-openapi'
import { isDeprecatedModel, OFFICIAL_VENDOR_PRICES, VENDOR_DEFAULTS } from '@/shared/data'
import { getPrismaClient } from '../db/client'
import { AuthMode, type Prisma, type PrismaClient } from '../generated/prisma/client'
import { logger } from '../logger'
import type { PriceSeedOutcomeSchema } from '../schemas/api/price'
import { apiStyleForVendor, modelApiStyleOverride } from './config'
import { chainEntryCascadeWarning } from './config/apply/chain-entries'

const OFFICIAL_VENDORS = ['openai', 'anthropic', 'google'] as const
type OfficialVendor = (typeof OFFICIAL_VENDORS)[number]

export type PriceSeedOutcome = z.infer<typeof PriceSeedOutcomeSchema>

type Tx = Prisma.TransactionClient
type PriceEntry = NonNullable<(typeof OFFICIAL_VENDOR_PRICES)[OfficialVendor]>[string]
type ProviderWithModels = NonNullable<Awaited<ReturnType<Tx['provider']['findUnique']>>> & {
  models: { name: string }[]
}

// Find or recreate the Provider row for a first-party vendor. A missing
// row means the user removed it or the DB pre-dates ensureSeedProviders;
// either way we reinstate it as api_key with no key set so the catalog
// stays seeded.
const ensureProviderRow = async (tx: Tx, vendor: OfficialVendor): Promise<ProviderWithModels> => {
  const existing = await tx.provider.findUnique({
    where: { name: vendor },
    include: { models: true }
  })
  if (existing) return existing
  const defaults = VENDOR_DEFAULTS[vendor]
  if (!defaults) {
    throw new Error(`VENDOR_DEFAULTS missing entry for first-party vendor "${vendor}"`)
  }
  return tx.provider.create({
    data: {
      name: vendor,
      apiBaseUrl: defaults.baseUrl,
      apiKey: null,
      authMode: AuthMode.api_key,
      apiStyle: apiStyleForVendor(vendor)
    },
    include: { models: true }
  })
}

// Delete model rows the scrape no longer lists. A chain entry naming one
// cascades away with it; there is no request to attach a warning to
// here, so the count goes to the log instead.
const deleteStaleModels = async (tx: Tx, providerId: string, stale: string[]): Promise<number> => {
  if (stale.length === 0) return 0
  const cascade = await chainEntryCascadeWarning(
    tx,
    { providerId, name: { in: stale } },
    `model(s) the price scrape no longer lists (${stale.join(', ')})`
  )
  if (cascade !== null) logger.warn({ providerId, stale }, `[price-seed] ${cascade}`)
  const res = await tx.model.deleteMany({
    where: { providerId, name: { in: stale } }
  })
  return res.count
}

const modelDataFromEntry = (id: string, entry: PriceEntry) => ({
  deprecated: isDeprecatedModel(id),
  legacy: Boolean(entry.legacy),
  inputPer1M: entry.inputPer1M,
  outputPer1M: entry.outputPer1M,
  cachedInputPer1M: entry.cachedInputPer1M === undefined ? null : entry.cachedInputPer1M,
  contextWindow: entry.contextWindow === undefined ? null : entry.contextWindow,
  apiStyle: modelApiStyleOverride(id)
})

// Upsert each scraped model row. Returns {created, updated} counts.
// Never overwrites Model.enabled — that's the user's toggle to own.
const upsertScrapedModels = async (
  tx: Tx,
  providerId: string,
  existingNames: ReadonlySet<string>,
  priceMap: Record<string, PriceEntry>
): Promise<{ created: number; updated: number }> => {
  const counters = { created: 0, updated: 0 }
  for (const id of Object.keys(priceMap)) {
    const entry = priceMap[id]
    const data = modelDataFromEntry(id, entry)
    if (existingNames.has(id)) {
      await tx.model.update({
        where: { providerId_name: { providerId, name: id } },
        data
      })
      counters.updated += 1
    } else {
      await tx.model.create({
        data: {
          providerId,
          name: id,
          ...data,
          enabled: !(data.deprecated || data.legacy)
        }
      })
      counters.created += 1
    }
  }
  return counters
}

const seedVendor = async (tx: Tx, vendor: OfficialVendor): Promise<PriceSeedOutcome> => {
  const priceMap = OFFICIAL_VENDOR_PRICES[vendor]
  if (!priceMap || Object.keys(priceMap).length === 0) {
    return { vendor, created: 0, updated: 0, deleted: 0, skipped: 'no scraped prices' }
  }

  const provider = await ensureProviderRow(tx, vendor)
  // Never touch a subscription-auth provider that happens to share the
  // name. (claude-code/codex use different names; this is belt-and-braces.)
  if (provider.authMode !== AuthMode.api_key) {
    return { vendor, created: 0, updated: 0, deleted: 0, skipped: 'provider is subscription auth' }
  }

  const desiredSet = new Set(Object.keys(priceMap))
  const stale = provider.models.filter((m) => !desiredSet.has(m.name)).map((m) => m.name)
  const deleted = await deleteStaleModels(tx, provider.id, stale)

  const existingNames = new Set(provider.models.map((m) => m.name))
  const { created, updated } = await upsertScrapedModels(tx, provider.id, existingNames, priceMap)
  return { vendor, created, updated, deleted }
}

// Copy per-token prices from official API providers onto subscription
// provider models that share the same model name. This lets the UI show
// estimated costs for subscription requests using API list prices as a
// proxy — the actual charge is plan-based, but it's a useful reference.
const syncSubscriptionPrices = async (tx: Tx): Promise<void> => {
  const [subscriptionProviders, apiModels] = await Promise.all([
    tx.provider.findMany({
      where: { authMode: AuthMode.subscription },
      include: { models: true }
    }),
    tx.model.findMany({
      where: { provider: { authMode: AuthMode.api_key }, inputPer1M: { not: null } },
      select: {
        name: true,
        inputPer1M: true,
        outputPer1M: true,
        cachedInputPer1M: true,
        provider: { select: { name: true } }
      }
    })
  ])

  // Build a name → priced API model lookup. When more than one API
  // provider lists the same model name, prefer the upstream vendor
  // (e.g. claude-* prices ride on anthropic, not on an OpenRouter
  // mirror) so the subscription cost estimate matches the source of
  // truth deterministically. Without this an unsorted findMany() would
  // pick whichever row happened to come first.
  const upstreamRank = (providerName: string): number => {
    const lower = providerName.toLowerCase()
    if (lower.includes('anthropic')) return 0
    if (lower.includes('openai')) return 0
    if (lower.includes('google') || lower.includes('gemini')) return 0
    return 1
  }
  const sortedApiModels = [...apiModels].sort((a, b) => {
    const r = upstreamRank(a.provider.name) - upstreamRank(b.provider.name)
    return r !== 0 ? r : a.provider.name.localeCompare(b.provider.name)
  })
  const byName = new Map<string, { inputPer1M: number; outputPer1M: number | null; cachedInputPer1M: number | null }>()
  for (const m of sortedApiModels) {
    if (!byName.has(m.name) && m.inputPer1M != null) {
      byName.set(m.name, { inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M, cachedInputPer1M: m.cachedInputPer1M })
    }
  }

  for (const provider of subscriptionProviders) {
    for (const model of provider.models) {
      const price = byName.get(model.name)
      if (!price) continue
      await tx.model.update({
        where: { providerId_name: { providerId: provider.id, name: model.name } },
        data: price
      })
    }
  }
}

export async function seedScrapedPricesIntoDb(prisma: PrismaClient = getPrismaClient()): Promise<PriceSeedOutcome[]> {
  const outcomes: PriceSeedOutcome[] = []
  for (const vendor of OFFICIAL_VENDORS) {
    outcomes.push(await prisma.$transaction((tx) => seedVendor(tx, vendor)))
  }
  await prisma.$transaction((tx) => syncSubscriptionPrices(tx))
  return outcomes
}

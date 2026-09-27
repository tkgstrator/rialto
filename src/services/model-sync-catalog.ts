import { OFFICIAL_VENDOR_PRICES, SUBSCRIPTION_PRESETS } from '@/shared/data'
import type { ScrapedPriceEntry } from '../vendors/base'
import { getVendorProvider, isScrapedVendor } from '../vendors/registry'

/**
 * The two questions a vendor catalog answers, kept apart because they
 * have different sources and different consequences.
 *
 * `listed` decides which Model rows exist. `priceById` only decides what
 * a row that already exists costs. Conflating them is how merging the
 * committed price table into a scraped vendor grew 43 api_key OpenAI
 * models on a Codex subscription: the table is a price list, not a
 * statement about what a provider serves.
 */
export interface VendorCatalog {
  listed: ScrapedPriceEntry[]
  priceById: Map<string, ScrapedPriceEntry>
}

export const emptyCatalog: VendorCatalog = { listed: [], priceById: new Map() }

// The static price table as a catalog, for vendors Rialto has prices for
// but no runtime scraper.
//
// This exists because filtering on `isScrapedVendor` alone threw prices
// away. Google has no native scraper — its numbers come from a build-time
// script committed into `src/shared/data/providers/google/prices.json` —
// so it fell out of the filter and every Gemini row was created with a
// null price, while Rialto held the published figure the whole time. The
// live `/v1/models` list only names models; it never carries a price, so
// nothing downstream filled the gap in.
const staticCatalog = (vendor: string): VendorCatalog | undefined => {
  const priced = OFFICIAL_VENDOR_PRICES[vendor]
  if (priced === undefined) return undefined
  const scraped: ScrapedPriceEntry[] = Object.entries(priced).map(([apiId, entry]) => ({
    apiId,
    inputPer1M: entry.inputPer1M,
    outputPer1M: entry.outputPer1M,
    cachedInputPer1M: entry.cachedInputPer1M === undefined ? null : entry.cachedInputPer1M,
    contextWindow: entry.contextWindow === undefined ? null : entry.contextWindow,
    legacy: entry.legacy === true
  }))
  return { listed: scraped, priceById: new Map(scraped.map((s) => [s.apiId, s])) }
}

/**
 * Live scrape over the committed table, for prices only.
 *
 * The two sources were an either/or: a vendor with a scraper used the
 * live result, one without used the table. That holds while a scrape
 * covers the vendor's lineup and goes silently wrong the moment it does
 * not. OpenAI's docs moved and its scrape fell to three models, so a
 * refresh priced three rows and left fifteen null — while the published
 * figures for all eighteen sat in `OFFICIAL_VENDOR_PRICES` the whole
 * time. It is the Gemini bug from the other side: that one was "the
 * table was never consulted", this one is "the table stopped being
 * consulted the moment a scraper existed".
 *
 * The scrape wins wherever it answers, being the fresher source and the
 * reason a refresh exists. The table only fills ids the scrape did not
 * mention — and only in `priceById`, so a price list can never conjure a
 * model the vendor did not list.
 */
export const withCommittedPrices = (live: ScrapedPriceEntry[], committed: VendorCatalog | undefined): VendorCatalog => {
  const priceById = new Map(live.map((s) => [s.apiId, s]))
  for (const entry of committed === undefined ? [] : committed.listed) {
    if (!priceById.has(entry.apiId)) priceById.set(entry.apiId, entry)
  }
  return { listed: live, priceById }
}

// Fetch every vendor scrape once up front so multiple providers that
// share a vendor (e.g. anthropic + claude-code) don't hit the docs site
// twice per refresh.
export async function loadVendorCatalogs(providerNames: ReadonlySet<string>): Promise<Map<string, VendorCatalog>> {
  const out = new Map<string, VendorCatalog>()
  await Promise.all(
    [...providerNames].map(async (name) => {
      const fallback = staticCatalog(name)
      if (isScrapedVendor(name)) {
        const provider = getVendorProvider(name)
        if (provider === undefined) return
        const scraped = await provider.scrape()
        out.set(name, withCommittedPrices(scraped, fallback))
        return
      }
      if (fallback !== undefined) out.set(name, fallback)
    })
  )
  return out
}

// Which price bucket to consult for a given Provider. Subscription
// providers borrow their api_key sibling's vendor (claude-code →
// anthropic, codex → openai) so they share the same output.
//
// A vendor Rialto holds committed prices for counts even without a
// runtime scraper. Returning null for those was the second half of the
// Gemini bug: `loadVendorCatalogs` could build a catalog from the static
// table, but nothing ever asked for it, so every Gemini row kept the null
// price it was created with. Both the load and the lookup have to agree
// on which vendors have prices at all.
export const scrapeVendorFor = (providerName: string): string | null => {
  if (isScrapedVendor(providerName)) return providerName
  if (OFFICIAL_VENDOR_PRICES[providerName] !== undefined) return providerName
  const preset = SUBSCRIPTION_PRESETS.find((p) => p.id === providerName)
  if (preset === undefined) return null
  const v = preset.vendor.toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai') return 'openai'
  return null
}

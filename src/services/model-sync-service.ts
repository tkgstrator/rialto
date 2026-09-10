/**
 * Refresh the Model catalog for every configured Provider.
 *
 * Two upstream sources per provider are combined:
 *   1. `/v1/models` on the vendor's REST API (needs api key). Adds
 *      any new IDs the shipped seed hadn't caught yet.
 *   2. Scraping the vendor's public pricing page (anthropic / openai /
 *      deepseek / codex today). Adds new IDs AND updates per-token
 *      prices, cachedInput, contextWindow, and the legacy flag on rows
 *      the scrape covers — so the UI's cost figures stay in sync with
 *      the vendor's list price without a redeploy.
 *
 * All vendor-specific plumbing lives under providers/<vendor>/; this
 * service just orchestrates. Subscription providers (claude-code,
 * codex) resolve to the same VendorProvider instance as their api_key
 * sibling in the registry, so they share the scrape output without a
 * second HTTP hit.
 */

import type { z } from '@hono/zod-openapi'
import { isDeprecatedModel, LLM_PRICES_SEED, OFFICIAL_VENDOR_PRICES, SUBSCRIPTION_PRESETS } from '@/shared/data'
import { getPrismaClient } from '../db/client'
import { AuthMode, type Prisma } from '../generated/prisma/client'
import { logger } from '../logger'
import type { RefreshOutcomeSchema } from '../schemas/api/models'
import type { ModelsCredential, ScrapedPriceEntry } from '../vendors/base'
import { getVendorProvider, isScrapedVendor } from '../vendors/registry'
import { modelApiStyleOverride } from './config'
import { getUsableSubAccountAuth } from './subscription-account-sync/read'

export type RefreshOutcome = z.infer<typeof RefreshOutcomeSchema>

// Per-vendor list of models that should ship as enabled on a fresh
// subscription provider. Refresh only auto-enables when a newly
// discovered id is on this list — otherwise the row lands disabled and
// the user opts in.
const subscriptionDefaultsById = (providerName: string): ReadonlySet<string> => {
  const preset = SUBSCRIPTION_PRESETS.find((p) => p.id === providerName)
  return new Set(preset === undefined ? [] : preset.defaultEnabledModels)
}

const modelDataFromScrape = (entry: ScrapedPriceEntry) => ({
  legacy: entry.legacy,
  inputPer1M: entry.inputPer1M,
  outputPer1M: entry.outputPer1M,
  cachedInputPer1M: entry.cachedInputPer1M,
  contextWindow: entry.contextWindow
})

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

const emptyCatalog: VendorCatalog = { listed: [], priceById: new Map() }

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
async function loadVendorCatalogs(providerNames: ReadonlySet<string>): Promise<Map<string, VendorCatalog>> {
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

interface ProviderRow {
  id: string
  name: string
  apiKey: string | null
  authMode: AuthMode
  models: { name: string }[]
}

// Compute the initial `enabled` for a fresh row. api_key providers
// enable everything but legacy/deprecated (mirrors price-seed-service).
// Subscription providers only auto-enable ids on the preset's curated
// defaultEnabledModels list — a Pro/Max plan may not entitle the user
// to the newest model.
const initialEnabled = (
  authMode: AuthMode,
  name: string,
  deprecated: boolean,
  legacy: boolean,
  defaults: ReadonlySet<string>
): boolean => {
  if (authMode === AuthMode.subscription) return defaults.has(name)
  return !(deprecated || legacy)
}

const buildCreateRow = (
  name: string,
  p: ProviderRow,
  scr: ScrapedPriceEntry | undefined,
  defaults: ReadonlySet<string>
): Prisma.ModelCreateManyInput => {
  const deprecated = isDeprecatedModel(name)
  const legacy = scr === undefined ? false : scr.legacy
  return {
    providerId: p.id,
    name,
    deprecated,
    legacy,
    enabled: initialEnabled(p.authMode, name, deprecated, legacy, defaults),
    inputPer1M: scr === undefined ? null : scr.inputPer1M,
    outputPer1M: scr === undefined ? null : scr.outputPer1M,
    cachedInputPer1M: scr === undefined ? null : scr.cachedInputPer1M,
    contextWindow: scr === undefined ? null : scr.contextWindow,
    apiStyle: modelApiStyleOverride(name)
  }
}

interface LiveFetchResult {
  ids: string[]
  error: string | undefined
}

// Live catalog from /v1/models. Skip for subscription providers or any
// api_key provider without a key on file.
async function fetchLiveCatalog(p: ProviderRow): Promise<LiveFetchResult> {
  if (p.authMode !== AuthMode.api_key) return { ids: [], error: undefined }
  if (p.apiKey === null || p.apiKey.trim() === '') {
    return { ids: [], error: 'no api key on file' }
  }
  const provider = getVendorProvider(p.name)
  if (provider === undefined) return { ids: [], error: 'unknown vendor' }
  const got = await provider.fetchLiveModels(p.apiKey)
  if (Array.isArray(got)) return { ids: got, error: undefined }
  return { ids: [], error: got.error }
}

// Sync price/context/legacy on every row we hold a price for. Never
// touches Model.enabled — that's the user's toggle.
//
// Driven from the rows that exist rather than from the price list, so a
// price the vendor publishes for a model this provider does not serve
// stays a lookup and never becomes an UPDATE against a missing row.
async function applyScrapedPrices(
  p: ProviderRow,
  catalog: VendorCatalog,
  existing: ReadonlySet<string>
): Promise<void> {
  const prisma = getPrismaClient()
  for (const name of existing) {
    const scr = catalog.priceById.get(name)
    if (scr === undefined) continue
    await prisma.model.update({
      where: { providerId_name: { providerId: p.id, name } },
      data: modelDataFromScrape(scr)
    })
  }
}

// Bring the `deprecated` flag on previously-seeded rows in line with
// the shared deprecations registry.
async function syncDeprecationFlags(p: ProviderRow, allCurrentNames: string[]): Promise<void> {
  const prisma = getPrismaClient()
  const flipToDeprecated = allCurrentNames.filter(isDeprecatedModel)
  const flipToActive = allCurrentNames.filter((n) => !isDeprecatedModel(n))
  if (flipToDeprecated.length > 0) {
    await prisma.model.updateMany({
      where: { providerId: p.id, name: { in: flipToDeprecated }, deprecated: false },
      data: { deprecated: true }
    })
  }
  if (flipToActive.length > 0) {
    await prisma.model.updateMany({
      where: { providerId: p.id, name: { in: flipToActive }, deprecated: true },
      data: { deprecated: false }
    })
  }
}

// Ask the vendor to look up per-model contextWindow from its docs pages
// for every id Rialto knows about (DB rows ∪ freshly-added rows). Runs
// regardless of whether the pricing scrape or /v1/models returned
// anything — subscription providers with an empty live catalog still
// get their existing rows' context refreshed. Values the vendor returns
// overwrite the current DB value; missing ids are left alone.
/**
 * What the catalog call can authenticate with.
 *
 * A subscription provider holds no api key, so this used to hand the
 * vendor `undefined` and the default implementation returned early. That
 * is why a signed-in Claude Code had a context window on four models and
 * null on the other thirteen: Anthropic publishes the figure per model on
 * `/v1/models` as `max_input_tokens`, and the only reason it went unread
 * was that nothing offered a credential. The OAuth access token is the
 * same one the request path already sends to that host.
 */
const modelsCredentialFor = async (p: ProviderRow): Promise<ModelsCredential | undefined> => {
  if (p.authMode === AuthMode.subscription) {
    const auth = await getUsableSubAccountAuth(p.name)
    if (auth === null || auth.accessToken === null) return undefined
    return { kind: 'subscription', accessToken: auth.accessToken }
  }
  if (p.apiKey === null || p.apiKey.trim() === '') return undefined
  return { kind: 'api_key', key: p.apiKey }
}

async function refreshContextWindows(p: ProviderRow, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const provider = getVendorProvider(p.name)
  if (provider === undefined) return 0
  // The credential is what lets the default implementation read the
  // vendor's own catalog endpoint; scraping overrides ignore it.
  const contexts = await provider.fetchContextWindows(ids, await modelsCredentialFor(p))
  if (contexts.size === 0) return 0
  const prisma = getPrismaClient()
  for (const [name, contextWindow] of contexts) {
    await prisma.model.update({
      where: { providerId_name: { providerId: p.id, name } },
      data: { contextWindow }
    })
  }
  return contexts.size
}

// Reconcile one Provider's models against the union of the /v1/models
// live list and the vendor's scraped catalog. Returns the outcome to
// report to the UI.
async function refreshOneProvider(p: ProviderRow, catalog: VendorCatalog): Promise<RefreshOutcome> {
  const prisma = getPrismaClient()
  const live = await fetchLiveCatalog(p)
  const desired = new Set<string>([...catalog.listed.map((s) => s.apiId), ...live.ids])
  const existing = new Set(p.models.map((m) => m.name))
  const toAdd = [...desired].filter((id) => !existing.has(id))
  const defaults = subscriptionDefaultsById(p.name)

  if (toAdd.length > 0) {
    const rows: Prisma.ModelCreateManyInput[] = toAdd.map((name) =>
      buildCreateRow(name, p, catalog.priceById.get(name), defaults)
    )
    await prisma.model.createMany({ data: rows, skipDuplicates: true })
  }

  await applyScrapedPrices(p, catalog, existing)
  await syncDeprecationFlags(p, [...existing, ...toAdd])

  // Contextwindow refresh runs against DB rows ∪ freshly added, so a
  // subscription provider with no pricing/live catalog still gets its
  // existing rows' context refreshed against the vendor's per-model
  // docs pages.
  const contextsUpdated = await refreshContextWindows(p, Array.from(new Set([...existing, ...toAdd])))

  // Report `error` only when NOTHING was accomplished. A subscription
  // provider that picked up new models via scrape (or refreshed the
  // contextWindow of existing ones) shouldn't be flagged just because
  // it has no api key.
  const succeeded = toAdd.length > 0 || catalog.listed.length > 0 || contextsUpdated > 0
  if (!succeeded) {
    const errorMsg = live.error === undefined ? 'no upstream catalog available' : live.error
    return { provider: p.name, added: [], error: errorMsg }
  }
  return { provider: p.name, added: toAdd, error: undefined }
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
const scrapeVendorFor = (providerName: string): string | null => {
  if (isScrapedVendor(providerName)) return providerName
  if (OFFICIAL_VENDOR_PRICES[providerName] !== undefined) return providerName
  const preset = SUBSCRIPTION_PRESETS.find((p) => p.id === providerName)
  if (preset === undefined) return null
  const v = preset.vendor.toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai') return 'openai'
  return null
}

export async function refreshModelsForAllProviders(): Promise<RefreshOutcome[]> {
  const prisma = getPrismaClient()
  const providers = await prisma.provider.findMany({ include: { models: true } })

  const providerNames = providers.map((p) => p.name)
  const scrapeVendors = new Set<string>()
  for (const p of providers) {
    const v = scrapeVendorFor(p.name)
    if (v !== null) scrapeVendors.add(v)
  }
  const catalogs = await loadVendorCatalogs(scrapeVendors)
  logger.info(
    {
      providerCount: providers.length,
      providerNames,
      scrapeVendors: [...scrapeVendors],
      listedCounts: Object.fromEntries([...catalogs].map(([k, v]) => [k, v.listed.length])),
      pricedCounts: Object.fromEntries([...catalogs].map(([k, v]) => [k, v.priceById.size]))
    },
    'refresh-models: vendor catalogs loaded'
  )

  const results: RefreshOutcome[] = []
  for (const p of providers) {
    const scrapeVendor = scrapeVendorFor(p.name)
    const fetched = scrapeVendor === null ? undefined : catalogs.get(scrapeVendor)
    const catalog: VendorCatalog = fetched === undefined ? emptyCatalog : fetched
    results.push(await refreshOneProvider(p, catalog))
  }
  await backfillStaticPrices()
  return results
}

// Fill in prices from the bundled llm-prices.json snapshot for any model
// the live scrape didn't cover (vendors without a scraper — qwen, xai,
// mistral, …). Only touches rows whose inputPer1M is still null, so
// scraped / already-set prices win. This makes the DB the single source
// of truth the UI reads (via provider.modelPrices), so the frontend needs
// no static-pricing fallback of its own.
async function backfillStaticPrices(): Promise<void> {
  const prisma = getPrismaClient()
  for (const p of LLM_PRICES_SEED.prices) {
    await prisma.model.updateMany({
      where: { name: p.id, inputPer1M: null },
      data: { inputPer1M: p.input, outputPer1M: p.output, cachedInputPer1M: p.input_cached }
    })
  }
}

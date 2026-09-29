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
 * Subscription providers (claude-code, codex) take only the id list and
 * prices from here. Their context window and effort levels are read once
 * from the subscription's own model list by model-capability-service,
 * and nothing here overwrites them.
 *
 * All vendor-specific plumbing lives under providers/<vendor>/; this
 * service just orchestrates. Subscription providers (claude-code,
 * codex) resolve to the same VendorProvider instance as their api_key
 * sibling in the registry, so they share the scrape output without a
 * second HTTP hit.
 */

import type { z } from '@hono/zod-openapi'
import { isDeprecatedModel, LLM_PRICES_SEED } from '@/shared/data'
import { getPrismaClient } from '../db/client'
import { AuthMode, type Prisma } from '../generated/prisma/client'
import { logger } from '../logger'
import type { RefreshOutcomeSchema } from '../schemas/api/models'
import type { ModelsCredential, ScrapedPriceEntry } from '../vendors/base'
import { getVendorProvider } from '../vendors/registry'
import { claudeCodeModels, refreshClaudeCodeModels } from './claude-code-model-catalog'
import { fetchCodexModels } from './codex-model-catalog'
import { captureModelCapabilities } from './model-capability-service'
import { emptyCatalog, loadVendorCatalogs, scrapeVendorFor, type VendorCatalog } from './model-sync-catalog'

export type { VendorCatalog } from './model-sync-catalog'
export { withCommittedPrices } from './model-sync-catalog'

import { modelApiStyleOverride } from './config'
import { getUsableSubAccountAuth } from './subscription-account-sync/read'

export type RefreshOutcome = z.infer<typeof RefreshOutcomeSchema>

// A subscription row's context window is the subscription's own figure,
// recorded once (model-capability-service); the scraped one describes the
// vendor's API and must not replace it.
const modelDataFromScrape = (entry: ScrapedPriceEntry, authMode: AuthMode) => ({
  legacy: entry.legacy,
  inputPer1M: entry.inputPer1M,
  outputPer1M: entry.outputPer1M,
  cachedInputPer1M: entry.cachedInputPer1M,
  ...(entry.contextWindow === null || authMode === AuthMode.subscription ? {} : { contextWindow: entry.contextWindow })
})

interface ProviderRow {
  id: string
  name: string
  apiKey: string | null
  authMode: AuthMode
  models: { name: string }[]
}

/**
 * A Model row for an id a refresh or a connect just found.
 *
 * Always switched off, on every provider. A tier routes to the newest
 * switched-on model its name says, so a row that landed on would move a
 * route the moment a vendor published a release — before anyone looked at
 * its price or whether the plan serves it. The operator turns it on.
 */
export const buildCreateRow = (
  name: string,
  p: ProviderRow,
  scr: ScrapedPriceEntry | undefined
): Prisma.ModelCreateManyInput => ({
  providerId: p.id,
  name,
  deprecated: isDeprecatedModel(name),
  legacy: scr === undefined ? false : scr.legacy,
  enabled: false,
  inputPer1M: scr === undefined ? null : scr.inputPer1M,
  outputPer1M: scr === undefined ? null : scr.outputPer1M,
  cachedInputPer1M: scr === undefined ? null : scr.cachedInputPer1M,
  contextWindow: scr === undefined || p.authMode === AuthMode.subscription ? null : scr.contextWindow,
  apiStyle: modelApiStyleOverride(name)
})

interface LiveFetchResult {
  ids: string[]
  error: string | undefined
}

// Codex advertises account-scoped choices; Claude Code's public selector
// lists candidates only. Neither vendor's API price sheet proves entitlement.
const fetchClaudeCodeCatalog = async (): Promise<LiveFetchResult> => {
  const found = await refreshClaudeCodeModels()
  return { ids: [...claudeCodeModels()], error: found ? undefined : 'Claude Code model catalog unavailable' }
}

async function fetchLiveCatalog(p: ProviderRow): Promise<LiveFetchResult> {
  if (p.name === 'claude-code' && p.authMode === AuthMode.subscription) return fetchClaudeCodeCatalog()
  if (p.authMode === AuthMode.subscription) {
    if (p.name !== 'codex') return { ids: [], error: undefined }
    const auth = await getUsableSubAccountAuth(p.name)
    if (auth === null || auth.accessToken === null) return { ids: [], error: 'no Codex account connected' }
    const ids = await fetchCodexModels(auth.accessToken, auth.accountId)
    return ids === null ? { ids: [], error: 'Codex model catalog unavailable' } : { ids, error: undefined }
  }
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
      data: modelDataFromScrape(scr, p.authMode)
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

const modelsCredentialFor = (p: ProviderRow): ModelsCredential | undefined =>
  p.apiKey === null || p.apiKey.trim() === '' ? undefined : { kind: 'api_key', key: p.apiKey }

// Ask the vendor to look up per-model contextWindow from its docs pages
// for every id Rialto knows about (DB rows ∪ freshly-added rows). Values
// the vendor returns overwrite the current DB value; missing ids are left
// alone. Subscription providers are skipped: their window is recorded
// once from the subscription's own list (model-capability-service).
async function refreshContextWindows(p: ProviderRow, ids: string[]): Promise<number> {
  if (ids.length === 0 || p.authMode === AuthMode.subscription) return 0
  const provider = getVendorProvider(p.name)
  if (provider === undefined) return 0
  // The credential is what lets the default implementation read the
  // vendor's own catalog endpoint; scraping overrides ignore it.
  const contexts = await provider.fetchContextWindows(ids, modelsCredentialFor(p))
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
  const desired = new Set<string>(
    p.name === 'codex' || p.name === 'claude-code' ? live.ids : [...catalog.listed.map((s) => s.apiId), ...live.ids]
  )
  const existing = new Set(p.models.map((m) => m.name))
  const toAdd = [...desired].filter((id) => !existing.has(id))

  // New rows land switched off (buildCreateRow), so a refresh offers a
  // release without moving any tier to it.
  if (toAdd.length > 0) {
    const rows: Prisma.ModelCreateManyInput[] = toAdd.map((name) =>
      buildCreateRow(name, p, catalog.priceById.get(name))
    )
    await prisma.model.createMany({ data: rows, skipDuplicates: true })
  }

  await applyScrapedPrices(p, catalog, existing)
  await syncDeprecationFlags(p, [...existing, ...toAdd])

  // Context-window refresh runs against DB rows ∪ freshly added, so a
  // subscription provider without pricing data still checks its known rows.
  const contextsUpdated = await refreshContextWindows(p, Array.from(new Set([...existing, ...toAdd])))

  // Discovery failures remain visible even when a pricing scrape succeeds;
  // price sheets cannot establish subscription model availability.
  if ((p.name === 'codex' || p.name === 'claude-code') && live.error !== undefined)
    return { provider: p.name, added: toAdd, error: live.error }
  // Report `error` only when NOTHING was accomplished. A subscription
  // provider that picked up new models via scrape (or refreshed the
  // contextWindow of existing ones) shouldn't be flagged just because
  // it has no api key.
  const succeeded =
    toAdd.length > 0 ||
    (p.name !== 'codex' && p.name !== 'claude-code' && catalog.listed.length > 0) ||
    contextsUpdated > 0 ||
    ((p.name === 'codex' || p.name === 'claude-code') && live.error === undefined)
  if (!succeeded) {
    const errorMsg = live.error === undefined ? 'no upstream catalog available' : live.error
    return { provider: p.name, added: [], error: errorMsg }
  }
  return { provider: p.name, added: toAdd, error: undefined }
}

// A successful OAuth connection should show its account's actual model
// choices on the next Providers reload, without waiting for Refresh.
export async function syncConnectedCodexModels(
  providerNames: readonly string[],
  accessToken: string,
  accountId: string | null,
  fetchModels: typeof fetch = fetch
): Promise<void> {
  const found = await fetchCodexModels(accessToken, accountId, fetchModels)
  const ids = found === null ? [] : found
  if (ids.length === 0) return
  const prisma = getPrismaClient()
  const providers = await prisma.provider.findMany({
    where: { name: { in: [...providerNames] }, authMode: AuthMode.subscription },
    include: { models: true }
  })
  for (const provider of providers) {
    const existing = new Set(provider.models.map((model) => model.name))
    const rows = ids.filter((name) => !existing.has(name)).map((name) => buildCreateRow(name, provider, undefined))
    if (rows.length > 0) await prisma.model.createMany({ data: rows, skipDuplicates: true })
  }
  await captureModelCapabilities(fetchModels)
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
  // Rows this refresh added still lack what never changes for their id.
  await captureModelCapabilities()
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

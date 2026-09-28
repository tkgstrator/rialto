/**
 * Assemble the "provider catalog" — the read-only reference view of
 * every vendor Rialto knows about, with its models and prices, plus
 * whether the user has enabled it (i.e. a Provider row exists).
 *
 * The catalog fuses three sources:
 *   1. Static seed shipped in @/shared/data:
 *        - VENDOR_DEFAULTS      → api_key vendor list + base URLs
 *        - SUBSCRIPTION_PRESETS → subscription vendor list (claude-code, codex)
 *        - OFFICIAL_VENDOR_PRICES → per-model prices scraped at build time
 *   2. A runtime scrape overlay for anthropic (see vendor-pricing-scraper.ts).
 *      Held in process memory; a restart falls back to the static seed
 *      until the next refresh call.
 *   3. The DB's Provider.name set, used to flip each entry's `enabled`
 *      flag.
 *
 * The catalog is intentionally not persisted to the DB. The Provider /
 * Model tables represent the user's opt-in state; the catalog is a
 * view over reference data.
 */

import type { z } from '@hono/zod-openapi'
import type { OfficialPricingEntry } from '@/shared/data'
import {
  CODEX_IMAGE_MODELS,
  isDeprecatedModel,
  OFFICIAL_VENDOR_PRICES,
  SUBSCRIPTION_PRESETS,
  VENDOR_DEFAULTS
} from '@/shared/data'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import type { CatalogEntrySchema, CatalogModelSchema } from '../schemas/api/catalog'
import type { ScrapedPriceEntry } from '../vendors/base'
import { type ImageModelDetails, imageModelSnapshot, refreshImageModelDetails } from '../vendors/openai/image-models'
import { getVendorProvider, scrapedVendors } from '../vendors/registry'
import { claudeCodeModels, ensureClaudeCodeModels, refreshClaudeCodeModels } from './claude-code-model-catalog'
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>
export type CatalogModel = z.infer<typeof CatalogModelSchema>

// In-process overlay: newest scrape wins over the static seed for that
// vendor. Cleared on server restart; the /api/catalog GET falls back to
// static data until a refresh is triggered.
interface Overlay {
  vendor: string
  scrapedAt: string
  entries: Map<string, ScrapedPriceEntry>
}
const overlayByVendor = new Map<string, Overlay>()
const imageOverlay = new Map<string, ImageModelDetails>()
const imageDetails = (name: string): ImageModelDetails | null => {
  const cached = imageOverlay.get(name)
  return cached === undefined ? imageModelSnapshot(name) : cached
}

const modelFromStatic = (name: string, entry: OfficialPricingEntry): CatalogModel => ({
  name,
  inputPer1M: entry.inputPer1M,
  outputPer1M: entry.outputPer1M,
  cachedInputPer1M: entry.cachedInputPer1M === undefined ? null : entry.cachedInputPer1M,
  contextWindow: entry.contextWindow === undefined ? null : entry.contextWindow,
  imagePricing: null,
  legacy: entry.legacy === true,
  deprecated: isDeprecatedModel(name)
})

const modelFromScraped = (scraped: ScrapedPriceEntry): CatalogModel => ({
  name: scraped.apiId,
  inputPer1M: scraped.inputPer1M,
  outputPer1M: scraped.outputPer1M,
  cachedInputPer1M: scraped.cachedInputPer1M,
  contextWindow: scraped.contextWindow,
  imagePricing: null,
  legacy: scraped.legacy,
  deprecated: isDeprecatedModel(scraped.apiId)
})

// Fuse static prices (SEED) + runtime overlay for one vendor. Overlay
// takes precedence for models present in both; overlay-only ids are
// appended. Names emitted in sorted order for a stable UI.
const modelsForVendor = (vendor: string): CatalogModel[] => {
  const staticMap = OFFICIAL_VENDOR_PRICES[vendor]
  const overlay = overlayByVendor.get(vendor)
  const out = new Map<string, CatalogModel>()
  if (staticMap !== undefined) {
    for (const [name, entry] of Object.entries(staticMap)) {
      const scraped = overlay === undefined ? undefined : overlay.entries.get(name)
      out.set(name, scraped === undefined ? modelFromStatic(name, entry) : modelFromScraped(scraped))
    }
  }
  if (overlay !== undefined) {
    for (const [name, scraped] of overlay.entries) {
      if (!out.has(name)) out.set(name, modelFromScraped(scraped))
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const lastRefreshedForVendor = (vendor: string): string | null => {
  const overlay = overlayByVendor.get(vendor)
  return overlay === undefined ? null : overlay.scrapedAt
}

interface CatalogSeed {
  name: string
  displayName: string
  authMode: 'api_key' | 'subscription'
  apiBaseUrl: string
  vendor: string
  cli: string | null
  credentialsPath: string | null
  modelsVendor: string
}

// Which OFFICIAL_VENDOR_PRICES bucket to consult for this catalog entry.
// Subscription providers borrow their api_key sibling's price list
// (claude-code → anthropic, codex → openai).
const modelsVendorFor = (name: string, authMode: 'api_key' | 'subscription'): string => {
  if (authMode === 'api_key') return name
  const preset = SUBSCRIPTION_PRESETS.find((p) => p.id === name)
  if (preset === undefined) return name
  const v = preset.vendor.toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai') return 'openai'
  return name
}

const seeds = (): CatalogSeed[] => {
  const out: CatalogSeed[] = []
  for (const name of Object.keys(VENDOR_DEFAULTS)) {
    const defaults = VENDOR_DEFAULTS[name]
    out.push({
      name,
      displayName: name,
      authMode: 'api_key',
      apiBaseUrl: defaults.baseUrl,
      vendor: name,
      cli: null,
      credentialsPath: null,
      modelsVendor: modelsVendorFor(name, 'api_key')
    })
  }
  for (const preset of SUBSCRIPTION_PRESETS) {
    out.push({
      name: preset.id,
      displayName: preset.label,
      authMode: 'subscription',
      apiBaseUrl: preset.apiBaseUrl,
      vendor: preset.vendor,
      cli: preset.cli,
      credentialsPath: preset.credentialsPath,
      modelsVendor: modelsVendorFor(preset.id, 'subscription')
    })
  }
  return out
}

// Which models a subscription has comes from the vendor, never from a
// list shipped here. Claude Code: its published selector (candidates, not
// an account's entitlements). Codex: the account's own list, which only
// exists once a provider is connected (getCatalog below), so before that
// the entry offers just the image models the Codex image endpoint serves.
const filterSubscriptionModels = (
  models: CatalogModel[],
  preset: (typeof SUBSCRIPTION_PRESETS)[number]
): CatalogModel[] => {
  if (preset.id !== 'codex') {
    const byName = new Map(models.map((model) => [model.name, model]))
    return claudeCodeModels()
      .map((name): CatalogModel => {
        const priced = byName.get(name)
        return priced === undefined
          ? {
              name,
              inputPer1M: null,
              outputPer1M: null,
              cachedInputPer1M: null,
              contextWindow: null,
              imagePricing: null,
              legacy: false,
              deprecated: isDeprecatedModel(name)
            }
          : priced
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  return [
    ...CODEX_IMAGE_MODELS.map((name): CatalogModel => {
      const details = imageDetails(name)
      return {
        name,
        // The generic three rates cannot encode both text and image
        // input; only the separately labeled detail block is authoritative.
        inputPer1M: null,
        outputPer1M: null,
        cachedInputPer1M: null,
        contextWindow: null,
        imagePricing: details,
        legacy: false,
        deprecated: false
      }
    })
  ].sort((a, b) => a.name.localeCompare(b.name))
}

const buildEntry = (seed: CatalogSeed, enabled: boolean): CatalogEntry => {
  const rawModels = modelsForVendor(seed.modelsVendor)
  const preset = seed.authMode === 'subscription' ? SUBSCRIPTION_PRESETS.find((p) => p.id === seed.name) : undefined
  const models = preset === undefined ? rawModels : filterSubscriptionModels(rawModels, preset)
  return {
    name: seed.name,
    displayName: seed.displayName,
    authMode: seed.authMode,
    apiBaseUrl: seed.apiBaseUrl,
    vendor: seed.vendor,
    cli: seed.cli,
    credentialsPath: seed.credentialsPath,
    models,
    enabled,
    lastRefreshedAt: lastRefreshedForVendor(seed.modelsVendor)
  }
}

export async function getCatalog(fetchModels: typeof fetch = fetch): Promise<CatalogEntry[]> {
  await ensureClaudeCodeModels(fetchModels)
  const prisma = getPrismaClient()
  const providers = await prisma.provider.findMany({
    select: { name: true, models: { select: { name: true, deprecated: true, legacy: true } } }
  })
  const enabledNames = new Set(providers.map((p) => p.name))
  return seeds().map((seed) => {
    const entry = buildEntry(seed, enabledNames.has(seed.name))
    if (seed.name !== 'codex' && seed.name !== 'claude-code') return entry
    const providerModels = providers.find((provider) => provider.name === seed.name)?.models
    if (providerModels === undefined) return entry
    const priced = new Map(entry.models.map((model) => [model.name, model]))
    const names =
      seed.name === 'codex'
        ? providerModels.map((model) => model.name)
        : [...new Set([...priced.keys(), ...providerModels.map((model) => model.name)])]
    return {
      ...entry,
      models: names.map((name): CatalogModel => {
        const model = providerModels.find((row) => row.name === name)
        const known = priced.get(name)
        if (known !== undefined) return known
        if (model === undefined) throw new Error('Catalog model row missing')
        return {
          name,
          inputPer1M: null,
          outputPer1M: null,
          cachedInputPer1M: null,
          contextWindow: null,
          imagePricing: null,
          legacy: model.legacy,
          deprecated: model.deprecated
        }
      })
    }
  })
}

export interface CatalogRefreshResult {
  entries: CatalogEntry[]
  scrapedVendors: string[]
  warnings: string[]
}

// Trigger a live scrape for every vendor with a scraper implementation,
// update the process-local overlay, then return the fresh catalog view.
// The user's enabled providers are NOT touched here — this endpoint is
// catalog-only. Refreshing Model rows on configured providers is the
// job of /api/refresh-models.
export async function refreshCatalog(): Promise<CatalogRefreshResult> {
  const scrapedList: string[] = []
  const warnings: string[] = []
  const now = dayjs().toISOString()
  await Promise.all(
    scrapedVendors().map(async (vendor) => {
      const provider = getVendorProvider(vendor)
      if (provider === undefined) return
      const scraped = await provider.scrape()
      if (scraped.length === 0) {
        warnings.push(`${vendor}: scrape returned no entries; static seed retained`)
        return
      }
      overlayByVendor.set(vendor, {
        vendor,
        scrapedAt: now,
        entries: new Map(scraped.map((s) => [s.apiId, s]))
      })
      scrapedList.push(vendor)
    })
  )
  const [images, codeModelsFound] = await Promise.all([refreshImageModelDetails(), refreshClaudeCodeModels()])
  if (!codeModelsFound) warnings.push('claude-code: model catalog unavailable; known models retained')
  for (const [name, details] of images) imageOverlay.set(name, details)
  if (images.size !== CODEX_IMAGE_MODELS.length)
    warnings.push('openai images: some model pages could not be read; committed prices retained')
  const entries = await getCatalog()
  return { entries, scrapedVendors: scrapedList, warnings }
}

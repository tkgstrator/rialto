/**
 * Vendor-published official pricing per provider, in USD per 1M tokens.
 *
 * Each `providers/<vendor>/prices.json` is the canonical source for
 * that vendor's official rates. The shape is intentionally trivial so
 * the per-vendor scraper scripts under `scripts/scrape-<vendor>-prices.ts`
 * can regenerate them without touching code. These official rates are
 * seeded into the DB by price-seed-service / model-sync-service, taking
 * precedence over the third-party llm-prices.json snapshot.
 *
 * Currently shipped:
 *   - openai     (developers.openai.com/api/docs/pricing)
 *   - anthropic  (platform.claude.com/docs/en/about-claude/pricing)
 *   - google     (ai.google.dev/gemini-api/docs/pricing — empty pending scraper)
 */

import { OPENAI_IMAGE_GENERATION_PRICE, OPENAI_IMAGE_MODELS } from '../openai-images'
import anthropic from './anthropic/prices.json'
import google from './google/prices.json'
import openai from './openai/prices.json'

export interface OfficialPricingEntry {
  inputPer1M: number
  outputPer1M: number
  /** True when the model appears under the vendor's "legacy" / "deprecated" surface on its pricing page. */
  legacy?: boolean
  /** Max context window in tokens, when the vendor publishes it. */
  contextWindow?: number
  /** USD per 1M cached-input (cache-read) tokens, when published. */
  cachedInputPer1M?: number
}

export interface VendorPriceFile {
  vendor: string
  source: string
  lastChecked: string
  notes?: string[]
  prices: Record<string, { input: number; output: number; legacy?: boolean; context?: number; cachedInput?: number }>
}

const FILES: VendorPriceFile[] = [openai, anthropic, google]

const buildLookup = (): Record<string, Record<string, OfficialPricingEntry>> => {
  const out: Record<string, Record<string, OfficialPricingEntry>> = {}
  for (const file of FILES) {
    const vendorMap: Record<string, OfficialPricingEntry> = {}
    for (const [id, entry] of Object.entries(file.prices)) {
      const out: OfficialPricingEntry = { inputPer1M: entry.input, outputPer1M: entry.output }
      if (entry.legacy) out.legacy = true
      if (entry.context != null) out.contextWindow = entry.context
      if (entry.cachedInput != null) out.cachedInputPer1M = entry.cachedInput
      vendorMap[id] = out
    }
    out[file.vendor] = vendorMap
  }
  for (const name of OPENAI_IMAGE_MODELS) out.openai[name] = OPENAI_IMAGE_GENERATION_PRICE
  return out
}

export const OFFICIAL_VENDOR_PRICES: Record<string, Record<string, OfficialPricingEntry>> = buildLookup()

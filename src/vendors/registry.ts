/**
 * Registry of every vendor provider Rialto knows how to talk to.
 * `model-sync-service` and `catalog-service` iterate over this map to
 * refresh prices + models; the DB's Provider.name is looked up here
 * to route to the right subclass.
 *
 * Adding a new vendor is a single line: `.set('name', new NewProvider())`.
 * Static fallback data (VENDOR_DEFAULTS / OFFICIAL_VENDOR_PRICES) is
 * still consulted by the config seed layer, but the runtime scrape +
 * live models path goes exclusively through this registry.
 */

import { VENDOR_DEFAULTS } from '@/shared'
import { AnthropicProvider } from './anthropic'
import type { VendorProvider } from './base'
import { DeepSeekProvider } from './deepseek'
import { GenericProvider } from './generic'
import { GoogleProvider } from './google'
import { OpenAIProvider } from './openai'

const anthropic = new AnthropicProvider()
const openai = new OpenAIProvider()
const deepseek = new DeepSeekProvider()
const google = new GoogleProvider()

const explicitRegistry = new Map<string, VendorProvider>()
explicitRegistry.set('anthropic', anthropic)
explicitRegistry.set('openai', openai)
explicitRegistry.set('deepseek', deepseek)
explicitRegistry.set('google', google)

// Subscription providers borrow their api_key sibling's catalog +
// price list directly:
//   - claude-code (Claude Pro / Max via CLI OAuth) → anthropic
//   - codex      (ChatGPT Plus / Pro via Codex CLI OAuth) → openai
// The subscription preset's `availableModels` filter still trims the
// list at catalog render time so users only see models their plan
// actually serves.
explicitRegistry.set('claude-code', anthropic)
explicitRegistry.set('codex', openai)

// Cache generic fallbacks so we don't rebuild them on every lookup.
const genericCache = new Map<string, VendorProvider>()

// Vendor names that have a native runtime scraper (i.e. a class that
// overrides scrape()). Callers use this to decide whether to bother
// invoking scrape() at all — everyone else uses the generic fallback
// whose scrape() returns [].
const SCRAPED_VENDORS: readonly string[] = ['anthropic', 'openai', 'deepseek', 'google']
const SCRAPED_VENDORS_SET = new Set(SCRAPED_VENDORS)

export const scrapedVendors = (): readonly string[] => SCRAPED_VENDORS

export const getVendorProvider = (name: string): VendorProvider | undefined => {
  const explicit = explicitRegistry.get(name)
  if (explicit !== undefined) return explicit
  const cached = genericCache.get(name)
  if (cached !== undefined) return cached
  // Only fall back if VENDOR_DEFAULTS knows this vendor; otherwise we
  // have no idea how to reach it.
  if (!(name in VENDOR_DEFAULTS)) return undefined
  const generic = new GenericProvider(name)
  genericCache.set(name, generic)
  return generic
}

export const isScrapedVendor = (name: string): boolean => SCRAPED_VENDORS_SET.has(name)

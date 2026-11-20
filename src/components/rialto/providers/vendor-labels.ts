/**
 * Presentation names and ordering for catalog vendors.
 *
 * The catalog cannot supply either. `catalog-service.ts` seeds every
 * api_key vendor with `displayName: name`, so the wire carries the raw
 * slug (`moonshot-ai`, `xai`), and it returns entries sorted
 * `name.localeCompare(name)`, which buries the subscription seats among
 * the api_key vendors alphabetically. The mocks specify both the names and
 * the order, so this table records a design decision rather than inventing
 * one. Vendors the mocks do not name fall back to the catalog's own values.
 */
import type { CatalogEntry, Provider } from './types'

/**
 * Rail order. Subscription seats lead: they are the differentiated thing
 * Rialto offers, and an operator adding one should not have to scroll past
 * seven pay-as-you-go vendors to find it.
 *
 * There is no `gemini-cli` row. It was wired up ahead of Phase 3-2 and was
 * never reachable — `catalog-service` builds subscription entries from
 * `SUBSCRIPTION_PRESETS`, which has no such preset. Phase 3-2 was then
 * descoped (see docs/plan/rialto/gemini-code-assist-spike.md), so the
 * entries were removed rather than left implying support that is not
 * coming. Gemini reaches Rialto through the `google` api_key row.
 */
const VENDOR_ORDER = [
  'claude-code',
  'codex',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'groq',
  'openrouter',
  'custom'
]

const VENDOR_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google AI',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  custom: 'Custom',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  'moonshot-ai': 'Moonshot AI',
  qwen: 'Qwen',
  xai: 'xAI'
}

/**
 * Brand shown on the provider rail's second line. Distinct from the label
 * because a vendor's product name and its brand differ — Google's API-key
 * offering is "Google AI", but the company behind the row is "Google".
 */
const VENDOR_BRAND: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  'moonshot-ai': 'Moonshot',
  qwen: 'Qwen',
  xai: 'xAI'
}

const VENDOR_HINT_KEY: Record<string, string> = {
  'claude-code': 'providers.vendorHint.claudeCode',
  codex: 'providers.vendorHint.codex',
  anthropic: 'providers.vendorHint.payAsYouGo',
  openai: 'providers.vendorHint.payAsYouGo',
  google: 'providers.vendorHint.aiStudio',
  deepseek: 'providers.vendorHint.payAsYouGo',
  groq: 'providers.vendorHint.openaiCompatible',
  openrouter: 'providers.vendorHint.aggregator',
  custom: 'providers.vendorHint.custom'
}

/** Trust `displayName` only when the catalog gave it a value of its own. */
const catalogLabel = (name: string, displayName: string): string => (displayName === name ? name : displayName)

export function vendorLabel(name: string, displayName: string): string {
  const named = VENDOR_LABEL[name]
  return named === undefined ? catalogLabel(name, displayName) : named
}

export function providerLabel(provider: Pick<Provider, 'name' | 'display_name'>, entry?: CatalogEntry): string {
  const displayName = provider.display_name
  if (entry?.name === 'openai' && (displayName === 'openai' || /^openai · [a-f0-9]{6}$/.test(displayName || ''))) {
    return vendorLabel('openai', 'openai')
  }
  if (displayName != null) return displayName
  return entry === undefined ? provider.name : vendorLabel(entry.name, entry.displayName)
}

export function vendorBrand(name: string, vendor: string): string {
  const named = VENDOR_BRAND[name]
  if (named !== undefined) return named
  // Subscription presets already carry a real brand ('Anthropic'); api_key
  // seeds set vendor to the slug, which is no better than the name.
  return catalogLabel(name, vendor)
}

/**
 * The hint as a translation key plus its interpolation values. Returning a
 * key rather than prose keeps this module free of `react-i18next`, which
 * is what lets the sort below stay a pure comparison the tests can call.
 */
export interface VendorHint {
  key: string
  values: { cli: string }
}

export function vendorHint(entry: CatalogEntry): VendorHint {
  const named = VENDOR_HINT_KEY[entry.name]
  const values = { cli: entry.cli === null ? '' : entry.cli }
  if (named !== undefined) return { key: named, values }
  if (entry.authMode !== 'subscription') return { key: 'providers.vendorHint.payAsYouGo', values }
  return entry.cli === null
    ? { key: 'providers.vendorHint.browserOauth', values }
    : { key: 'providers.vendorHint.cliOauth', values }
}

const groupOf = (entry: CatalogEntry): number => (entry.authMode === 'subscription' ? 0 : 1)

const rankOf = (entry: CatalogEntry): number => {
  const i = VENDOR_ORDER.indexOf(entry.name)
  return i === -1 ? VENDOR_ORDER.length : i
}

/**
 * Subscription seats first, then the order the mock lays out, then
 * anything the mock does not name — alphabetically by its display label,
 * not by its slug, so `moonshot-ai` sorts under M.
 */
export function sortVendors(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const byGroup = groupOf(a) - groupOf(b)
    if (byGroup !== 0) return byGroup
    const byRank = rankOf(a) - rankOf(b)
    if (byRank !== 0) return byRank
    return vendorLabel(a.name, a.displayName).localeCompare(vendorLabel(b.name, b.displayName))
  })
}

/**
 * Base class + shared types for per-vendor providers.
 *
 * Each subclass under providers/<vendor>/ knows how to:
 *   1. Fetch the vendor's live model catalog from its `/v1/models`-style
 *      endpoint (fetchLiveModels), given an api key.
 *   2. Scrape the vendor's public pricing / models docs pages for
 *      per-token prices, context windows, and legacy flags (scrape).
 *
 * Both methods swallow failures and return empty results — the caller
 * (model-sync-service, catalog-service) unions whatever comes back and
 * moves on, so a temporary outage on one vendor never blocks the rest.
 *
 * The base class ships a default fetchLiveModels implementation driven
 * by `modelsEndpoint` + `modelsAuth`, matching the previous
 * VENDOR_DEFAULTS shape. Vendors with non-standard `/v1/models`
 * responses override it.
 */

import type { z } from '@hono/zod-openapi'
import { logger } from '../logger'
import { VendorModelsResponseSchema } from '../schemas/api/models'
export interface ScrapedPriceEntry {
  apiId: string
  // Nullable to accommodate credit-based vendors (Codex) whose pricing
  // page publishes credits per 1M tokens, not dollars — the scraper
  // still returns the model list so new ids get picked up, but the
  // dollar columns land as null on those rows.
  inputPer1M: number | null
  outputPer1M: number | null
  cachedInputPer1M: number | null
  contextWindow: number | null
  legacy: boolean
}

export type ModelsAuth = 'bearer' | 'x-api-key' | 'google-key-param'

type VendorModelsResponse = z.infer<typeof VendorModelsResponseSchema>

/**
 * Context window per model id, from whatever the catalog response
 * published. Google's ListModels carries `inputTokenLimit` on every
 * entry; OpenAI's does not, and OpenAI-compatible vendors that add
 * `context_window` are read on the same pass. Ids the response did not
 * describe are simply absent — the caller only writes what a vendor
 * confirmed.
 */
const extractContextWindows = (data: VendorModelsResponse): Map<string, number> => {
  const out = new Map<string, number>()
  for (const m of data.data === undefined ? [] : data.data) {
    if (typeof m.id !== 'string' || m.id.length === 0) continue
    // Two vendors, two names for one number.
    const limit = m.context_window === undefined ? m.max_input_tokens : m.context_window
    if (limit !== undefined) out.set(m.id, limit)
  }
  for (const m of data.models === undefined ? [] : data.models) {
    if (typeof m.name === 'string' && m.name.length > 0 && m.inputTokenLimit !== undefined) {
      out.set(m.name.replace(/^models\//, ''), m.inputTokenLimit)
    }
  }
  return out
}

const extractModelIds = (data: VendorModelsResponse): string[] | null => {
  if (Array.isArray(data.data)) {
    return data.data.flatMap((m) => (typeof m.id === 'string' && m.id.length > 0 ? [m.id] : []))
  }
  if (Array.isArray(data.models)) {
    return data.models.flatMap((m) => {
      if (typeof m.name !== 'string' || m.name.length === 0) return []
      return [m.name.replace(/^models\//, '')]
    })
  }
  return null
}

/**
 * How the catalog call proves who it is: the vendor's own api-key scheme,
 * chosen per vendor by `modelsAuth`. Subscription providers (Claude Code,
 * Codex) do not come through here; their context windows are read once
 * from the subscription's own model list by model-capability-service.
 */
export type ModelsCredential = { kind: 'api_key'; key: string }

const buildAuthedRequest = (
  auth: ModelsAuth,
  credential: ModelsCredential,
  url: string
): { url: string; headers: Record<string, string> } => {
  const base: Record<string, string> = { Accept: 'application/json' }
  const apiKey = credential.key
  if (auth === 'bearer') return { url, headers: { ...base, Authorization: `Bearer ${apiKey}` } }
  if (auth === 'x-api-key') {
    return { url, headers: { ...base, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
  }
  return { url: `${url}?key=${encodeURIComponent(apiKey)}`, headers: base }
}

export abstract class VendorProvider {
  abstract readonly vendor: string
  protected abstract readonly modelsEndpoint: string | null
  protected abstract readonly modelsAuth: ModelsAuth | null

  /**
   * Scrape the vendor's public pricing pages. Default: no scraping.
   * Vendors that publish pricing on rendered HTML override this to
   * return per-model prices, context windows, and legacy flags.
   */
  async scrape(): Promise<ScrapedPriceEntry[]> {
    return []
  }

  /**
   * Look up per-model context window from the vendor's per-model docs
   * pages. Called from refreshOneProvider with the DB's current model
   * list (existing rows ∪ freshly-added rows) so subscription-only ids
   * that never surface on the pricing table (`gpt-5.6-*` on Codex, for
   * example) can still be refreshed against the vendor's own detail
   * pages. Default: empty Map — vendors without per-model detail pages
   * skip this path entirely. Missing values (page 404, figure not
   * present) are omitted rather than reported; the caller only updates
   * rows the vendor confirmed a value for.
   */
  async fetchContextWindows(ids: readonly string[], credential?: ModelsCredential): Promise<Map<string, number>> {
    // Default source is the vendor's own catalog endpoint, because some
    // vendors publish the limit right there — Google's ListModels returns
    // `inputTokenLimit` on every model, and discarding it was why every
    // Gemini row carried a null context window while the vendor had been
    // answering the question all along. Vendors whose catalog omits it
    // (OpenAI) override this with a docs-scraping implementation.
    if (this.modelsEndpoint === null || this.modelsAuth === null) return new Map()
    if (credential === undefined) return new Map()
    const { url, headers } = buildAuthedRequest(this.modelsAuth, credential, this.modelsEndpoint)
    const res = await fetch(url, { headers }).catch(() => null)
    if (res === null || !res.ok) return new Map()
    const body: unknown = await res.json().catch(() => null)
    const parsed = VendorModelsResponseSchema.safeParse(body)
    if (!parsed.success) return new Map()
    const published = extractContextWindows(parsed.data)
    // Only answer for ids the caller actually holds rows for.
    const wanted = new Set(ids)
    return new Map([...published].filter(([id]) => wanted.has(id)))
  }

  /**
   * Hit the vendor's `/v1/models`-style endpoint and return the flat
   * list of model ids. Returns [] on any failure — network, non-2xx,
   * malformed response — so a bad vendor never blocks the refresh loop.
   * Returns { error } shape callers can log against.
   */
  async fetchLiveModels(apiKey: string): Promise<string[] | { error: string }> {
    if (this.modelsEndpoint === null || this.modelsAuth === null) {
      return { error: 'no models endpoint configured for this vendor' }
    }
    const { url, headers } = buildAuthedRequest(this.modelsAuth, { kind: 'api_key', key: apiKey }, this.modelsEndpoint)
    const res = await fetch(url, { headers })
    if (!res.ok) return { error: `${this.vendor} returned HTTP ${res.status}` }
    const parsed = VendorModelsResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { error: `${this.vendor} returned an unrecognised response shape` }
    const ids = extractModelIds(parsed.data)
    if (ids === null) return { error: `${this.vendor} returned an unrecognised response shape` }
    return ids
  }
}

/**
 * Fetch a scraper page as plain HTML. Returns null on any failure so
 * callers can degrade to their static fallback without try/catch.
 */
export async function fetchScrapePage(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      // Vendor docs sites (Mintlify, Astro) all render tables inline in
      // the SSR HTML; a plain Node fetch UA gets the same payload as a
      // browser.
      'User-Agent': 'Mozilla/5.0 (compatible; rialto-refresh-models/1.0)',
      Accept: 'text/html'
    }
  })
  if (!res.ok) {
    logger.warn({ url, status: res.status }, 'vendor pricing fetch: non-2xx')
    return null
  }
  return await res.text()
}

// Strip HTML tags and normalise whitespace. Cells embed <br/>, <a>,
// nested <span>s; we only need the visible text.
export const cellText = (raw: string): string =>
  raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const matchAllGroups = (html: string, pattern: RegExp): string[] => [...html.matchAll(pattern)].map((m) => m[1])

export const splitRows = (tableHtml: string): string[] => matchAllGroups(tableHtml, /<tr[^>]*>([\s\S]*?)<\/tr>/gi)

export const splitCells = (rowHtml: string): string[] =>
  matchAllGroups(rowHtml, /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi).map(cellText)

export const findTables = (html: string): string[] => matchAllGroups(html, /<table[^>]*>([\s\S]*?)<\/table>/gi)

// "$5 / MTok" → 5, "$0.50" → 0.5, "$0.0028/1M tokens" → 0.0028, "—" → null.
export const parsePrice = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === '—') return null
  const m = trimmed.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/)
  return m !== null ? Number(m[1]) : null
}

// "200K" → 200000, "1M tokens" → 1000000. Takes the first number so
// "200K (1M with beta)" resolves to the standard window.
export const parseContext = (raw: string): number | null => {
  const m = raw.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)\s*([KM])?/i)
  if (m === null) return null
  const n = Number(m[1])
  const unit = m[2] === undefined ? '' : m[2].toUpperCase()
  if (unit === 'M') return Math.round(n * 1e6)
  if (unit === 'K') return Math.round(n * 1e3)
  return Math.round(n)
}

/**
 * OpenAI vendor provider — api_key path. Scrapes the flagship LLM
 * pricing tables at developers.openai.com/api/docs/pricing.
 *
 * The page ships one table per tier in the SSR HTML (Standard, Batch,
 * Fast, Ultrafast), all under the same header. Only the Standard tier
 * matches per-token API billing; the others are repricings that only apply
 * on those specific endpoints, so we skip them. How tables, tiers and
 * columns are told apart lives in ./pricing-table.ts.
 *
 * The SSR table shows only the newest models. The older rows are carried
 * in the island's serialized props and unfolded in the browser by the
 * "All models" toggle, so this scrape sees the current lineup and leaves
 * the rest to the committed price table (see withCommittedPrices).
 * Long-context prices have moved out of the table entirely (a separate
 * prop behind a client-side switch), so what the table shows is always the
 * short-context rate that unmarked calls bill at.
 *
 * Codex-family and image / audio models live on separate pricing pages
 * (see providers/codex/index.ts) — this scraper ignores those tables.
 */

import { logger } from '../../logger'
import { fetchScrapePage, type ModelsCredential, type ScrapedPriceEntry, VendorProvider } from '../base'
import { findPricingTables, type PricingTable, pickStandard, readPriceRow } from './pricing-table'

const PRICING_URL = 'https://developers.openai.com/api/docs/pricing'

const entriesOf = (table: PricingTable): ScrapedPriceEntry[] =>
  table.rows.flatMap((row) => {
    const read = readPriceRow(row, table.columns)
    return read === null ? [] : [{ ...read, contextWindow: null, legacy: false }]
  })

// Per-model docs page URL the "N,NNN,NNN context window" figure lives on.
const MODEL_DOCS_URL = (id: string): string => `https://developers.openai.com/api/docs/models/${id}`

// Bounded concurrency for per-model fetches — 6 in flight at once keeps
// a full-catalog refresh (~60 ids) well under a minute without hammering
// developers.openai.com. Simple worker-pool: N workers pop from a shared
// mutable list until it's empty.
const CONTEXT_FETCH_CONCURRENCY = 6

// React SSR emits an HTML comment between adjacent text nodes so
// hydration can align them — the model docs page ships e.g.
// `<div>1,050,000<!-- --> context window</div>`, which puts a comment
// between the number and the label. Strip HTML comments before matching
// so the plain-text regex catches the pattern regardless.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const CONTEXT_RE = /([0-9][0-9,]*)\s*context window/i

const parseContextFromHtml = (html: string): number | null => {
  const m = html.replace(HTML_COMMENT_RE, ' ').match(CONTEXT_RE)
  if (m === null) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export class OpenAIProvider extends VendorProvider {
  readonly vendor = 'openai'
  protected readonly modelsEndpoint = 'https://api.openai.com/v1/models'
  protected readonly modelsAuth = 'bearer' as const

  async scrape(): Promise<ScrapedPriceEntry[]> {
    const html = await fetchScrapePage(PRICING_URL)
    if (html === null) return []
    const candidates = findPricingTables(html)
    const tables = pickStandard(candidates)
    if (tables.length === 0) {
      logger.warn(
        { matchedTiers: candidates.map((t) => t.tier) },
        'openai scrape: Standard-tier flagship table not found'
      )
      return []
    }
    // A model can appear in more than one Standard table (the main one and a
    // model-group one); the earlier table is the main listing, so it wins.
    const seen = new Set<string>()
    const out = tables.flatMap(entriesOf).filter((entry) => {
      if (seen.has(entry.apiId)) return false
      seen.add(entry.apiId)
      return true
    })
    if (out.length === 0)
      logger.warn({ tables: tables.length }, 'openai scrape: Standard-tier tables held no priced rows')
    return out
  }

  // The pricing page returns no contextWindow — this walks the per-model
  // docs pages instead. Each page publishes "N,NNN,NNN context window"
  // near the header; we grep for that pattern. Called from
  // refreshOneProvider so every DB row (including Codex subscription
  // ids like `gpt-5.6-*` that never appear on the pricing table) gets
  // its context refreshed against the vendor's own docs.
  // The credential is accepted to match the base signature and
  // deliberately unused: OpenAI's catalog endpoint does not publish the
  // context window, so this reads the per-model docs pages instead.
  async fetchContextWindows(ids: readonly string[], _credential?: ModelsCredential): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const queue = [...ids]
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const id = queue.shift()
        if (id === undefined) return
        const html = await fetchScrapePage(MODEL_DOCS_URL(id))
        if (html === null) continue
        const n = parseContextFromHtml(html)
        if (n !== null) out.set(id, n)
      }
    }
    const workerCount = Math.min(CONTEXT_FETCH_CONCURRENCY, queue.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    return out
  }
}

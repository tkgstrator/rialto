/**
 * Google vendor provider. Scrapes ai.google.dev's Gemini pricing page so
 * the Refresh button picks up new models and price changes without a
 * redeploy.
 *
 * Until this existed `google` fell through to GenericProvider, whose
 * scrape() returns [] — so Gemini prices came only from the committed
 * `shared/data/providers/google/prices.json`, and a model published
 * after the last run of scripts/scrape-gemini-pricing.ts (Playwright,
 * offline) had no price at all. The button was there and could not
 * work.
 *
 * The docs page is server-rendered, so the same numbers are reachable
 * with a plain fetch and the regex helpers in base.ts — no chromium at
 * request time. Context windows are deliberately not read here: Google's
 * ListModels publishes `inputTokenLimit` per model, which the base class
 * already reads, and that covers every served model rather than the
 * Gemini 3 subset the docs table lists.
 */

import { logger } from '../../logger'
import { cellText, fetchScrapePage, type ScrapedPriceEntry, splitCells, splitRows, VendorProvider } from '../base'

const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing'

// The page is a flat sequence: an <h2 id="gemini-..."> opens a model,
// the <h3>s under it name a tier ("Standard" / "Batch" / "Cached"), and
// every <table> belongs to the tier above it. findTables() throws that
// order away, so the scan has to see all three node kinds in one pass.
const SECTION_RE = /<h2\b([^>]*)>|<h3\b[^>]*>([\s\S]*?)<\/h3>|<table\b[^>]*>([\s\S]*?)<\/table>/gi
const ID_ATTR = /\bid="([^"]+)"/i

// The heading id is the canonical api id ("gemini-3.8-flash"), which is
// why it is read instead of the display name. Imagen / Veo / Lyria /
// Gemma sections are billed per image, per second or not at all, and
// `pricing-for-tools` / `notes` are prose — none of them are models.
const modelIdOf = (attrs: string): string | null => {
  const found = ID_ATTR.exec(attrs)
  if (found === null) return null
  return /^gemini[-\d]/.test(found[1]) ? found[1] : null
}

interface TierTable {
  id: string
  tier: string | null
  rows: string[][]
}

interface Cursor {
  id: string | null
  tier: string | null
}

const collectTables = (html: string): TierTable[] => {
  const out: TierTable[] = []
  const cursor: Cursor = { id: null, tier: null }
  for (const m of html.matchAll(SECTION_RE)) {
    const [, headingAttrs, tierHeading, tableHtml] = m
    if (headingAttrs !== undefined) {
      cursor.id = modelIdOf(headingAttrs)
      cursor.tier = null
      continue
    }
    if (tierHeading !== undefined) {
      cursor.tier = cellText(tierHeading)
      continue
    }
    if (tableHtml === undefined || cursor.id === null) continue
    out.push({ id: cursor.id, tier: cursor.tier, rows: splitRows(tableHtml).map(splitCells) })
  }
  return out
}

// Every table is (dimension | Free Tier | Paid Tier). A section that
// publishes only one price column drops the free one, so the paid rate
// is the last cell rather than a fixed index.
const paidCell = (rows: string[][], label: RegExp): string | undefined => {
  const row = rows.find((cells) => cells.length > 0 && label.test(cells[0]))
  if (row === undefined) return undefined
  return row.length >= 3 ? row[2] : row[1]
}

/**
 * The paid rate out of one cell.
 *
 * Cells carry more than a number: "$0.75 through December 31, 2026.
 * $1.50 starting January 1, 2027." is an introductory rate and its
 * successor, and "$0.075 ... $0.50 / 1,000,000 tokens per hour (storage
 * price)" is a per-token rate followed by a storage rate. The first
 * $-number is the one in force for tokens today, which is also the rule
 * the offline scraper uses — the two must agree or a refresh would
 * rewrite every row it touched.
 *
 * The `$` is required: "Free of charge" and "5,000 free search requests"
 * both carry digits, and neither is a token price.
 */
const paidPrice = (raw: string | undefined): number | null => {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '' || /^free/i.test(trimmed) || /not available/i.test(trimmed)) return null
  const m = trimmed.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/)
  return m === null ? null : Number(m[1])
}

// "Standard" is the rate a request actually pays; Batch is half price
// and Cached is a different dimension entirely. Sections that publish a
// single unlabelled table are already standard.
const isStandard = (tier: string | null): boolean => tier === null || /^standard\b/i.test(tier)

const entryFor = (id: string, tables: TierTable[]): ScrapedPriceEntry | null => {
  const standard = tables.find((t) => isStandard(t.tier))
  const table = standard === undefined ? tables[0] : standard
  if (table === undefined) return null
  const inputPer1M = paidPrice(paidCell(table.rows, /input price/i))
  const outputPer1M = paidPrice(paidCell(table.rows, /output price/i))
  // Both or neither: an embedding model prices input and has no output
  // row, and a half-priced row would be worse than no row at all.
  if (inputPer1M === null || outputPer1M === null) return null
  return {
    apiId: id,
    inputPer1M,
    outputPer1M,
    cachedInputPer1M: paidPrice(paidCell(table.rows, /context caching price/i)),
    // Google publishes this per model on ListModels; see the header.
    contextWindow: null,
    // The pricing page lists what is on sale and simply drops what is
    // not, so nothing here is marked retired.
    legacy: false
  }
}

export class GoogleProvider extends VendorProvider {
  readonly vendor = 'google'
  protected readonly modelsEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models'
  protected readonly modelsAuth = 'google-key-param' as const

  async scrape(): Promise<ScrapedPriceEntry[]> {
    const html = await fetchScrapePage(PRICING_URL)
    if (html === null) return []
    const tables = collectTables(html)
    const byId = new Map<string, TierTable[]>()
    for (const table of tables) {
      const bucket = byId.get(table.id)
      if (bucket === undefined) byId.set(table.id, [table])
      else bucket.push(table)
    }
    const out: ScrapedPriceEntry[] = []
    for (const [id, group] of byId) {
      const entry = entryFor(id, group)
      if (entry !== null) out.push(entry)
    }
    // An empty result means the page stopped looking the way this parser
    // expects. Callers treat [] as "nothing to update" and keep the
    // committed table, so the only cost of a layout change is a stale
    // price — but it has to be visible in the log.
    if (out.length === 0) logger.warn('google scrape: no priced Gemini sections found')
    return out
  }
}

// Exposed for tests only. The heading-id filter and the paid-cell rule
// are the two pieces that silently drop or misprice a model: a filter
// that is too narrow loses a family, and reading the wrong $-number
// writes a plausible price nobody can tell is wrong.
export const __testables = { collectTables, entryFor, modelIdOf, paidPrice }

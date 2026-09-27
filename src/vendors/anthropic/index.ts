/**
 * Anthropic vendor provider. Scrapes platform.claude.com's pricing +
 * models-overview pages so the Refresh button picks up new models
 * (Sonnet 5, Fable 5, ...) and price changes without a redeploy.
 *
 * The build-time script under scripts/scrape-anthropic-prices.ts uses
 * Playwright to render the same Mintlify docs; here we rely on the
 * server-rendered HTML the docs site ships, parsed with regex — no
 * chromium at request time.
 */

import { logger } from '../../logger'
import {
  fetchScrapePage,
  findTables,
  parseContext,
  parsePrice,
  type ScrapedPriceEntry,
  splitCells,
  splitRows,
  VendorProvider
} from '../base'

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OVERVIEW_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'

// Legacy Claude 3.x dated ids keyed by trimmed display name. Kept in
// sync with scripts/scrape-anthropic-prices.ts LEGACY_IDS.
const LEGACY_IDS: Record<string, string> = {
  'Claude Haiku 3.5': 'claude-3-5-haiku-20241022',
  'Claude Sonnet 3.7': 'claude-3-7-sonnet-20250219',
  'Claude Sonnet 3.5': 'claude-3-5-sonnet-20241022',
  'Claude Haiku 3': 'claude-3-haiku-20240307',
  'Claude Opus 3': 'claude-3-opus-20240229'
}

const orEmpty = (v: string | undefined): string => (v === undefined ? '' : v)

// "Claude Opus 4 (deprecated)" → "Claude Opus 4"
const stripStatus = (display: string): string => display.replace(/\s*\([^)]*\)\s*$/, '').trim()

// "Claude Opus 4.7"  → "claude-opus-4-7"
// "Claude Opus 5"     → "claude-opus-5"    (no implicit .0 from 5 on)
// "Claude Fable 5.1"  → "claude-fable-5-1"
//
// Kept in step with the build-time scraper
// (scripts/scrape-anthropic-prices.ts). This copy used to recognise only
// Opus / Sonnet / Haiku *and* to require a minor, so every no-minor row
// fell through to the overview-page lookup — which is how a live refresh
// returned nine models and silently omitted Claude Opus 5, Claude Fable
// 5.1 and Claude Sonnet 5 while the pricing page listed all three.
// `modelPrefix` below already knew about Fable and Mythos; only this
// half of the pair did not.
const claude4PlusSlug = (display: string): string | null => {
  const m = display.match(/^Claude\s+(Opus|Sonnet|Haiku|Fable|Mythos)\s+(\d+)(?:\.(\d+))?$/i)
  if (m === null) return null
  const tier = m[1].toLowerCase()
  const major = Number(m[2])
  if (major < 4) return null
  if (m[3] !== undefined) return `claude-${tier}-${major}-${m[3]}`
  // The 4 generation spells x.0 as `-4-0`; from 5 on there is no minor
  // segment at all, and inventing one produces ids that do not exist.
  return major >= 5 ? `claude-${tier}-${major}` : `claude-${tier}-${major}-0`
}

// Extract just the "Claude <Tier> <Major>[.Minor]" prefix, dropping any
// trailing " through August 31, 2026" / " starting September 1, 2026"
// / " (limited availability)" style modifiers the pricing page hangs
// off multi-row models.
const modelPrefix = (display: string): string | null => {
  const m = display.match(/^(Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)?)\b/i)
  return m === null ? null : m[1]
}

interface OverviewMaps {
  displayToApiId: Record<string, string>
  displayToContext: Record<string, number>
}

const emptyOverview: OverviewMaps = { displayToApiId: {}, displayToContext: {} }

const resolveApiId = (display: string, cleaned: string, overview: OverviewMaps): string | undefined => {
  const exact = overview.displayToApiId[display]
  if (exact !== undefined) return exact
  const cleanedHit = overview.displayToApiId[cleaned]
  if (cleanedHit !== undefined) return cleanedHit
  const prefix = modelPrefix(cleaned)
  if (prefix !== null) {
    const prefixHit = overview.displayToApiId[prefix]
    if (prefixHit !== undefined) return prefixHit
    const slug = claude4PlusSlug(prefix)
    if (slug !== null) return slug
    const legacyHit = LEGACY_IDS[prefix]
    if (legacyHit !== undefined) return legacyHit
  }
  const slug = claude4PlusSlug(cleaned)
  if (slug !== null) return slug
  return LEGACY_IDS[cleaned]
}

const recordApiId = (display: string, cell: string | undefined, maps: OverviewMaps): void => {
  if (cell !== undefined && cell !== '') maps.displayToApiId[display] = cell
}

const recordContext = (display: string, cell: string | undefined, maps: OverviewMaps): void => {
  if (cell === undefined) return
  const ctx = parseContext(cell)
  if (ctx !== null) maps.displayToContext[display] = ctx
}

/**
 * The model name out of a comparison-table header cell.
 *
 * The cell holds the name and its blurb with no separator between them
 * once the markup is stripped: "Claude Fable 5.1For demanding reasoning
 * and long-horizon agentic work". Registering that whole string as the
 * key meant nothing on the pricing page ever matched it, which is why
 * every model's context window came back null and the newest ids had to
 * fall back to the slug rule.
 *
 * `modelPrefix` cannot be reused here: its trailing `\b` fails between
 * "1" and "F", and the engine backtracks to "Claude Fable 5" — the wrong
 * model. The name simply ends where the digits do.
 */
const headerModelName = (cell: string): string | null => {
  const m = cell.match(/^(Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)?)/i)
  return m === null ? null : m[1]
}

const readOverviewTable = (rows: string[][], maps: OverviewMaps): void => {
  const header = rows[0]
  if (!header.some((c) => /claude/i.test(c))) return
  const apiIdRow = rows.find((r) => /^claude api id$/i.test(orEmpty(r[0])))
  const ctxRow = rows.find((r) => /context\s*window/i.test(orEmpty(r[0])))
  for (let i = 1; i < header.length; i++) {
    const display = headerModelName(orEmpty(header[i]))
    if (display === null) continue
    recordApiId(display, apiIdRow === undefined ? undefined : apiIdRow[i], maps)
    recordContext(display, ctxRow === undefined ? undefined : ctxRow[i], maps)
  }
}

const parseOverview = (html: string): OverviewMaps => {
  const maps: OverviewMaps = { displayToApiId: {}, displayToContext: {} }
  for (const table of findTables(html)) {
    const rows = splitRows(table).map(splitCells)
    if (rows.length > 0) readOverviewTable(rows, maps)
  }
  return maps
}

// Locate the model-pricing table by its leaf headers rather than its
// position: the current page groups Input/Output under Base tokens,
// while the earlier table used one flat header row.
const findPricingTable = (html: string): { headers: string[]; rows: string[][] } | null => {
  for (const table of findTables(html)) {
    const rows = splitRows(table).map(splitCells)
    if (rows.length === 0) continue
    const headers = rows.find(
      (row) =>
        row.some((c) => /^model$|^name$/i.test(c)) &&
        row.some((c) => /^input$|base input/i.test(c)) &&
        row.some((c) => /^output$|output tokens/i.test(c))
    )
    if (headers !== undefined) return { headers, rows: rows.slice(rows.indexOf(headers) + 1) }
  }
  return null
}

const isLegacyDisplay = (display: string): boolean => /\((deprecated|retired)[^)]*\)/i.test(display)

interface ColumnIndices {
  input: number
  output: number
  cacheRead: number
}

const findColumns = (headers: string[]): ColumnIndices | null => {
  const idx = (label: string): number => headers.findIndex((h) => h.toLowerCase().includes(label.toLowerCase()))
  const input = headers.findIndex((h) => /^(base )?input(?: tokens)?$/i.test(h))
  const output = headers.findIndex((h) => /^output(?: tokens)?$/i.test(h))
  if (input < 0 || output < 0) return null
  const cacheRead = idx('cache hits')
  return { input, output, cacheRead: cacheRead < 0 ? idx('hits and refreshes') : cacheRead }
}

const contextFor = (display: string, cleaned: string, overview: OverviewMaps): number | null => {
  const exact = overview.displayToContext[display]
  if (exact !== undefined) return exact
  const cleanedHit = overview.displayToContext[cleaned]
  if (cleanedHit !== undefined) return cleanedHit
  const prefix = modelPrefix(cleaned)
  if (prefix !== null) {
    const prefixHit = overview.displayToContext[prefix]
    if (prefixHit !== undefined) return prefixHit
  }
  return null
}

const readPriceRow = (row: string[], cols: ColumnIndices, overview: OverviewMaps): ScrapedPriceEntry | null => {
  const display = row[0]
  if (display === undefined || display === '') return null
  const cleaned = stripStatus(display)
  const name = headerModelName(cleaned)
  const apiId = resolveApiId(display, name === null ? cleaned : name, overview)
  if (apiId === undefined) return null
  const inputPer1M = parsePrice(orEmpty(row[cols.input]))
  const outputPer1M = parsePrice(orEmpty(row[cols.output]))
  if (inputPer1M === null || outputPer1M === null) return null
  const cachedInputPer1M = cols.cacheRead >= 0 ? parsePrice(orEmpty(row[cols.cacheRead])) : null
  return {
    apiId,
    inputPer1M,
    outputPer1M,
    cachedInputPer1M,
    contextWindow: contextFor(display, name === null ? cleaned : name, overview),
    legacy: isLegacyDisplay(display)
  }
}

const parsePricingPage = (pricingHtml: string, overviewHtml: string | null): ScrapedPriceEntry[] | null => {
  const table = findPricingTable(pricingHtml)
  if (table === null) return null
  const cols = findColumns(table.headers)
  if (cols === null) return null
  const overview = overviewHtml === null ? emptyOverview : parseOverview(overviewHtml)
  const seen = new Set<string>()
  const out: ScrapedPriceEntry[] = []
  for (const row of table.rows) {
    const entry = readPriceRow(row, cols, overview)
    if (entry === null || seen.has(entry.apiId)) continue
    seen.add(entry.apiId)
    out.push(entry)
  }
  return out
}

export class AnthropicProvider extends VendorProvider {
  readonly vendor = 'anthropic'
  protected readonly modelsEndpoint = 'https://api.anthropic.com/v1/models'
  protected readonly modelsAuth = 'x-api-key' as const

  async scrape(): Promise<ScrapedPriceEntry[]> {
    const [pricingHtml, overviewHtml] = await Promise.all([fetchScrapePage(PRICING_URL), fetchScrapePage(OVERVIEW_URL)])
    if (pricingHtml === null) return []
    const prices = parsePricingPage(pricingHtml, overviewHtml)
    if (prices === null) {
      logger.warn('anthropic scrape: model-pricing table header signature not found')
      return []
    }
    return prices
  }
}

// Re-export for callers that still import the old service name.
export const scrapeAnthropicPricing = (): Promise<ScrapedPriceEntry[]> => new AnthropicProvider().scrape()

// Exposed for tests only. The display-name → API-id rule is the piece
// that silently drops models when it is wrong (a family it does not
// know is skipped; an invented `.0` produces an id the vendor never
// published), and both failures are invisible from the scrape's output
// alone — the model simply is not there.
export const __testables = { claude4PlusSlug, headerModelName, parsePricingPage }

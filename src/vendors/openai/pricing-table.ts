/**
 * Reading the flagship text-token tables on developers.openai.com/api/docs/pricing.
 *
 * Pure string-in, rows-out, so the runtime scraper (index.ts) and the
 * build-time generator (scripts/scrape-openai-prices.ts) read the page by
 * the same rules. The two drifted apart once already: both hard-coded the
 * column order, and when OpenAI moved "Output" ahead of "Cached input" the
 * runtime scrape returned nothing while the generator quietly wrote the
 * 30m cache-write rate into the committed seed as the output price.
 *
 * Everything here is keyed on what the page *says*, never on where it
 * says it:
 *   - columns are found by header name, in whatever order they come;
 *   - the header row is the first row that reads as one, not "row 2";
 *   - the Standard tier is the table the page labels `standard`, not "the
 *     first one".
 */

import { parsePrice, splitCells, splitRows } from '../base'

export interface Columns {
  model: number
  input: number
  output: number
  cachedInput: number
}

export interface PricingTable {
  /** The tier the page labels this table with, or null when its markup carries no label. */
  tier: string | null
  columns: Columns
  /** Body rows only: everything above and including the header row is dropped. */
  rows: string[][]
}

export interface PriceRead {
  apiId: string
  inputPer1M: number
  outputPer1M: number
  cachedInputPer1M: number | null
}

type Role = 'model' | 'input' | 'output' | 'cachedInput' | 'cacheWrite'

const roleOf = (cell: string): Role | null => {
  if (/^model$/i.test(cell)) return 'model'
  if (/^input$/i.test(cell)) return 'input'
  if (/^output$/i.test(cell)) return 'output'
  if (/^cached input$/i.test(cell)) return 'cachedInput'
  // "30m write", "12h write": what it costs to *store* a prompt in the
  // cache. A real column on this table, and a price that sits next to the
  // output rate in the markup, but not one we read.
  if (/ write$/i.test(cell)) return 'cacheWrite'
  return null
}

/**
 * The columns of a header row, or null when the row is not the flagship
 * header.
 *
 * The signature is an allow-list: every non-empty cell must be a column we
 * understand. The pricing page has several other tables that also carry
 * "Model", "Input", "Output" and "Cached input" — realtime and image
 * (+ Modality), fine-tuning (+ Training), codex (+ Category) — and their
 * extra column changes what the other prices mean (a fine-tuned model's
 * rate is not the base model's). Matching on the four names alone would
 * read all of them as flagship prices. An unknown column therefore makes a
 * table "not ours", which fails loudly (empty scrape, warning) rather than
 * writing someone else's price under a model id.
 *
 * The first occurrence of each name wins. The old layout repeated
 * Input / Cached input / Output for the long-context block after the
 * short-context one, and unmarked calls bill at short-context rates.
 */
export const columnsOf = (cells: readonly string[]): Columns | null => {
  const roles = cells.map(roleOf)
  if (cells.some((cell, i) => cell !== '' && roles[i] === null)) return null
  const model = roles.indexOf('model')
  const input = roles.indexOf('input')
  const output = roles.indexOf('output')
  const cachedInput = roles.indexOf('cachedInput')
  if (model < 0 || input < 0 || output < 0 || cachedInput < 0) return null
  return { model, input, output, cachedInput }
}

const locateHeader = (rows: readonly string[][]): { at: number; columns: Columns } | null => {
  for (const [at, cells] of rows.entries()) {
    const columns = columnsOf(cells)
    if (columns !== null) return { at, columns }
  }
  return null
}

// Each tier's table sits in an <astro-island> whose serialized props name
// it: props="{&quot;tier&quot;:[0,&quot;standard&quot;],...}". The attribute
// value may legitimately contain ">" inside its quotes, so the opening tag is
// matched quote-aware instead of up to the first ">".
const ISLAND_OPEN_RE = /<astro-island\b(?:[^>"']|"[^"]*"|'[^']*')*>/g
const TIER_PROP_RE = /"tier":\[0,"([a-z-]+)"\]/
const TABLE_RE = /<table[^>]*>([\s\S]*?)<\/table>/gi

const tierOf = (openTag: string): string | null => {
  const m = openTag.replace(/&quot;/g, '"').match(TIER_PROP_RE)
  return m === null ? null : m[1]
}

/**
 * Every table on the page whose header reads as the flagship header, with
 * the tier its enclosing island labels it with.
 *
 * A table belongs to the nearest island that opens before it. A table
 * outside any island, or inside one that carries no `tier` prop, is
 * unlabelled.
 */
export const findPricingTables = (html: string): PricingTable[] => {
  const islands = [...html.matchAll(ISLAND_OPEN_RE)].map((m) => ({ at: m.index, tier: tierOf(m[0]) }))
  return [...html.matchAll(TABLE_RE)].flatMap((m) => {
    const rows = splitRows(m[1]).map(splitCells)
    const header = locateHeader(rows)
    if (header === null) return []
    const owner = islands.filter((island) => island.at < m.index).at(-1)
    return [{ tier: owner === undefined ? null : owner.tier, columns: header.columns, rows: rows.slice(header.at + 1) }]
  })
}

/**
 * The Standard tier's tables out of everything `findPricingTables` found.
 *
 * Only Standard is per-token API billing; Batch, Fast and Ultrafast reprice
 * the same models and share the same header, so the header cannot tell them
 * apart. When the page labels its tiers, the label decides — and that
 * includes the model-group tables (cyber, life sciences) that sit after the
 * last tier tab and are Standard-priced too, which "the first table" would
 * never reach. When the page labels nothing (the layout before the labels,
 * and a bare fixture), the first table is Standard, as it always was.
 *
 * Labels present but none of them `standard` is an empty answer, not a
 * guess at which table to fall back on.
 */
export const pickStandard = (tables: readonly PricingTable[]): PricingTable[] =>
  tables.some((t) => t.tier !== null) ? tables.filter((t) => t.tier === 'standard') : tables.slice(0, 1)

const orEmpty = (v: string | undefined): string => (v === undefined ? '' : v)

// Model ids on the page are already the API-facing form (gpt-6-astra,
// gpt-4.1-nano, ...). Blank and dash cells are not models. A cell like
// "gpt-5.5 (<272K context length)" keeps only the id; the price beside it is
// the short-context one, which is the one we want.
const cleanModelId = (raw: string): string | null => {
  const s = raw.trim()
  if (s === '' || s === '—' || s === '-') return null
  const m = s.match(/^([a-z0-9][a-z0-9.\-_]*)/i)
  return m === null ? null : m[1]
}

/**
 * One body row as a price, or null when it is not a priced model row
 * (a blank, a divider, a model with no input or output rate).
 *
 * A missing cached-input rate is information, not an error — some models
 * ("-") have no cache discount — so it stays null.
 */
export const readPriceRow = (row: readonly string[], cols: Columns): PriceRead | null => {
  const apiId = cleanModelId(orEmpty(row[cols.model]))
  if (apiId === null) return null
  const inputPer1M = parsePrice(orEmpty(row[cols.input]))
  const outputPer1M = parsePrice(orEmpty(row[cols.output]))
  if (inputPer1M === null || outputPer1M === null) return null
  return { apiId, inputPer1M, outputPer1M, cachedInputPer1M: parsePrice(orEmpty(row[cols.cachedInput])) }
}

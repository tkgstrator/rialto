#!/usr/bin/env bun
/**
 * Scrape OpenAI's pricing page and emit
 * src/shared/data/vendor-prices/openai.json.
 *
 *   bun run scripts/scrape-openai-prices.ts          # write the JSON
 *   bun run scripts/scrape-openai-prices.ts --dry    # print + count only
 *
 * Tied to the current page layout (Astro `.content-switcher-root` with
 * `data-value="standard|batch|fast|ultrafast"` panes, plus inline "All
 * models" toggle buttons that reveal legacy rows). If OpenAI redesigns
 * the page the parsers below stop matching — `--dry` will surface that
 * by reporting a much lower model count than expected.
 *
 * The flagship text-token tables are read by column *name*, through the
 * same module the runtime scraper uses (src/vendors/openai/pricing-table.ts).
 * Reading them by position is how the committed seed once came to carry the
 * 30m cache-write rate as `output` for every gpt-5.6-* row.
 *
 * What we keep:
 *   - Flagship: Standard tier (the "All models" toggle unfolds the older
 *     rows and a second table of legacy rows: gpt-5, gpt-4.1, o3, etc.)
 *   - Multimodal: realtime / image / transcription, *text* modality
 *   - Specialized: ChatGPT / Codex / Deep research / Computer use /
 *     Embedding / Moderation (Standard tier)
 * What we drop:
 *   - Sora / video (per-second), TTS / Whisper (per-character /
 *     per-minute), Tools (web search), Finetuning training rates
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { type Columns, columnsOf, readPriceRow } from '../src/vendors/openai/pricing-table'

const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing'
const OUT = join(import.meta.dir, '../src/shared/data/providers/openai/prices.json')

interface RawTable {
  tier: 'standard' | 'batch' | 'flex' | 'priority' | 'fast' | 'ultrafast' | null
  fromAllModels: boolean
  headerRows: string[][]
  bodyRows: string[][]
}

interface PriceRow {
  id: string
  input: number
  output: number
  legacy: boolean
  cachedInput?: number
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(SOURCE_URL, { waitUntil: 'networkidle' })

// Tag every <table> that exists *before* expanding the "All models"
// toggles so we can tell apart current vs. legacy rows after the click
// inflates the DOM. We re-read this attribute below when extracting.
await page.evaluate(() => {
  for (const t of Array.from(document.querySelectorAll('table'))) {
    t.setAttribute('data-pre-all-models', '1')
  }
})

// Expand every "All models" toggle inside a pricing switcher pane so
// legacy rows (gpt-5, gpt-4.1, o-series, gpt-3.5, davinci, babbage, …)
// join the DOM. The page also has same-labelled buttons inside the nav
// menus — those navigate away from the page, so we scope the locator
// to .content-switcher-root.
const toggles = page.locator('.content-switcher-root button:has-text("All models")')
const toggleCount = await toggles.count()
for (let i = 0; i < toggleCount; i++) {
  try {
    await toggles.nth(i).click({ timeout: 2000 })
  } catch {
    // Some toggles only exist inside inactive tier panes; ignore.
  }
}

const tables = await page.evaluate((): RawTable[] => {
  const out: RawTable[] = []
  for (const node of Array.from(document.querySelectorAll('table'))) {
    let cur: Element | null = node
    let tier: RawTable['tier'] = null
    while (cur) {
      const v = cur.getAttribute('data-value')
      if (
        v === 'standard' ||
        v === 'batch' ||
        v === 'flex' ||
        v === 'priority' ||
        v === 'fast' ||
        v === 'ultrafast'
      ) {
        tier = v
        break
      }
      cur = cur.parentElement
    }
    const fromAllModels = node.getAttribute('data-pre-all-models') !== '1'
    const headerRows: string[][] = Array.from(node.querySelectorAll('thead tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th')).map((th) => (th.textContent ?? '').trim())
    )
    const bodyRows: string[][] = Array.from(node.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((cell) => (cell.textContent ?? '').trim())
    )
    out.push({ tier, fromAllModels, headerRows, bodyRows })
  }
  return out
}, undefined)

// browser stays open — per-model context windows are fetched below.

// --- Parsers ---------------------------------------------------------------

const parsePrice = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '-' || trimmed === '—') return null
  const match = trimmed.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/)
  if (!match) return null
  return Number(match[1])
}

// Model ids are lowercase alphanumeric with `.` and `-`, and never
// start with a separator. Suffixes like " with data sharing" appear on
// some finetuning rows — we reject those by requiring start-to-end match.
const isModelId = (s: string): boolean => /^[a-z0-9][a-z0-9.\-]*$/.test(s.trim())

// Flagship text-token tables (the current-lineup table and the legacy
// expansion the All models toggle adds): columns are found by header name,
// so the order they come in does not matter and the cache-write columns
// are never read.
const parseFlagship = (t: RawTable, cols: Columns): PriceRow[] =>
  t.bodyRows.flatMap((row) => {
    const read = readPriceRow(row, cols)
    if (read === null) return []
    const r: PriceRow = { id: read.apiId, input: read.inputPer1M, output: read.outputPer1M, legacy: t.fromAllModels }
    if (read.cachedInputPer1M != null) r.cachedInput = read.cachedInputPer1M
    return [r]
  })

// Realtime / audio / image: "Model | Modality | Input | Cached | Output".
// The model id is on a row where col 1 names the primary modality;
// follow-up rows in the same model only have the modality + prices.
//
// We prefer the Text-modality row for realtime/audio (most comparable
// to text-token rates) and the Image-modality row for image-generation
// tables (where the Text row has no output billing — primary modality
// is what users will be charged on). The table type is told apart by
// whether the Output column says "Output / cost" (realtime) or just
// "Output" (image).
const parseModalityTable = (t: RawTable): PriceRow[] => {
  const header = t.headerRows[t.headerRows.length - 1] ?? []
  const modalityIdx = header.findIndex((h) => /^modality$/i.test(h))
  const inputIdx = header.findIndex((h) => /^input$/i.test(h))
  const outputIdx = header.findIndex((h) => /^output($| \/)/i.test(h))
  if (modalityIdx < 0 || inputIdx < 0 || outputIdx < 0) return []
  const isRealtime = header.some((h) => /output \/ cost/i.test(h))
  const preferred = isRealtime ? 'text' : 'image'
  const fallback = isRealtime ? 'image' : 'text'

  // Group rows by their model id so we can pick the best modality per
  // model rather than emitting one row per (model, modality) pair.
  type Row = { modality: string; input: number | null; output: number | null }
  const grouped = new Map<string, Row[]>()
  let lastId: string | null = null
  for (const row of t.bodyRows) {
    let id: string | null
    let cells: string[]
    if (isModelId(row[0])) {
      id = row[0]
      cells = row
      lastId = id
    } else {
      id = lastId
      cells = ['(continuation)', ...row]
    }
    if (!id) continue
    const modality = (cells[modalityIdx] ?? '').toLowerCase()
    const input = parsePrice(cells[inputIdx])
    const output = parsePrice(cells[outputIdx])
    const list = grouped.get(id) ?? []
    list.push({ modality, input, output })
    grouped.set(id, list)
  }

  const out: PriceRow[] = []
  for (const [id, rows] of grouped) {
    const pick = (modality: string): Row | undefined =>
      rows.find((r) => r.modality === modality && r.input != null && r.output != null)
    const winner = pick(preferred) ?? pick(fallback) ?? rows.find((r) => r.input != null && r.output != null)
    if (!winner || winner.input == null || winner.output == null) continue
    out.push({ id, input: winner.input, output: winner.output, legacy: t.fromAllModels })
  }
  return out
}

// Transcription section: "Model | Use case | Input | Output | Estimated cost"
const parseTranscription = (t: RawTable): PriceRow[] => {
  const out: PriceRow[] = []
  for (const row of t.bodyRows) {
    if (!isModelId(row[0])) continue
    const input = parsePrice(row[2])
    const output = parsePrice(row[3])
    if (input == null || output == null) continue
    out.push({ id: row[0], input, output, legacy: t.fromAllModels })
  }
  return out
}

// Specialized: "Category | Model | Input | Output | Cached input" (the
// last two have traded places before, so columns are found by name). The
// Category cell spans rows: follow-up rows in the same category collapse
// the leading column and arrive one cell short, so every index slides left
// by however many cells that row is missing.
const parseSpecialized = (t: RawTable): PriceRow[] => {
  const header = t.headerRows[t.headerRows.length - 1] ?? []
  const at = (name: RegExp): number => header.findIndex((h) => name.test(h))
  const modelIdx = at(/^model$/i)
  const inputIdx = at(/^input$/i)
  const outputIdx = at(/^output$/i)
  const cachedIdx = at(/^cached input$/i)
  if (modelIdx < 0 || inputIdx < 0 || outputIdx < 0) return []
  const out: PriceRow[] = []
  for (const row of t.bodyRows) {
    const shift = header.length - row.length
    if (shift < 0 || shift > modelIdx) continue
    const id = row[modelIdx - shift] ?? ''
    if (!isModelId(id)) continue
    const input = parsePrice(row[inputIdx - shift] ?? '')
    if (input == null) continue
    const outputCell = row[outputIdx - shift] ?? ''
    const output = parsePrice(outputCell)
    // Embedding / moderation: output is "-" or "Free" — emit 0 so the
    // UI can still display "$X / —" cleanly.
    const isInputOnly = output == null || /^free$/i.test(outputCell) || outputCell === '-' || outputCell === ''
    const cachedInput = cachedIdx < 0 ? null : parsePrice(row[cachedIdx - shift] ?? '')
    const r: PriceRow = { id, input, output: isInputOnly ? 0 : (output ?? 0), legacy: t.fromAllModels }
    if (cachedInput != null) r.cachedInput = cachedInput
    out.push(r)
  }
  return out
}

const parseTable = (t: RawTable): PriceRow[] => {
  if (t.tier && t.tier !== 'standard') return [] // Batch / Flex / Priority are different tiers
  const flagshipColumns = columnsOf(t.headerRows[t.headerRows.length - 1] ?? [])
  if (flagshipColumns !== null) return parseFlagship(t, flagshipColumns)
  const headerFlat = t.headerRows.flat().join(' | ').toLowerCase()
  if (headerFlat.includes('modality') && headerFlat.includes('cached input')) return parseModalityTable(t)
  if (headerFlat.includes('use case') && headerFlat.includes('input') && headerFlat.includes('output')) {
    return parseTranscription(t)
  }
  if (headerFlat.includes('category') && headerFlat.includes('model') && headerFlat.includes('input')) {
    return parseSpecialized(t)
  }
  // Finetuning: "Model | Training | Input | Cached | Output" — Training
  // is per-hour, not per-token, so we drop those tables.
  if (headerFlat.includes('training')) return []
  // Sora / video: "Model | Size | Portrait | Landscape | Price per second" — drop.
  if (headerFlat.includes('price per second') || headerFlat.includes('landscape')) return []
  // Tools: "Tool | Details | Pricing" — drop.
  if (/^tool\b/.test(headerFlat) && headerFlat.includes('pricing')) return []
  return []
}

// --- Aggregate -------------------------------------------------------------

interface OutEntry {
  input: number
  output: number
  legacy?: boolean
  context?: number
  cachedInput?: number
}

const prices: Record<string, OutEntry> = {}
for (const t of tables) {
  for (const r of parseTable(t)) {
    if (prices[r.id]) continue // first write wins; primary (current) tables run first
    const entry: OutEntry = { input: r.input, output: r.output }
    if (r.legacy) entry.legacy = true
    if (r.cachedInput != null) entry.cachedInput = r.cachedInput
    prices[r.id] = entry
  }
}

if (Object.keys(prices).length === 0) {
  console.error('No prices parsed — page layout likely changed. Aborting without overwrite.')
  process.exit(1)
}

const sorted: Record<string, OutEntry> = {}
for (const id of Object.keys(prices).sort()) sorted[id] = prices[id]

// Context window is not on the pricing page — each model has a detail
// page at /api/docs/models/<id> whose body shows e.g. "1,050,000
// context window". Fetch it for EVERY id the pricing scrape produced,
// including legacy rows: the legacy detail pages still publish the
// figure (the pricing table just doesn't repeat it), and Rialto's failover
// capability gate needs the value regardless of whether OpenAI still
// promotes the model. Pages that 404 or omit the figure are skipped
// (context is optional).
const ctxRe = /([0-9][0-9,]*)\s*context window/i
let ctxHits = 0
for (const id of Object.keys(sorted)) {
  try {
    const resp = await page.goto(`https://developers.openai.com/api/docs/models/${id}`, {
      waitUntil: 'networkidle',
      timeout: 30_000
    })
    if (!resp || !resp.ok()) continue
    const body = await page.evaluate(() => document.body.innerText || '')
    const m = body.match(ctxRe)
    if (m) {
      const n = Number(m[1].replace(/,/g, ''))
      if (Number.isFinite(n) && n > 0) {
        sorted[id].context = n
        ctxHits++
      }
    }
  } catch {
    // Missing page / nav timeout — leave context unset for this model.
  }
}
console.error(`Resolved context window for ${ctxHits} model id(s)`)

await browser.close()

const payload = {
  vendor: 'openai',
  source: SOURCE_URL,
  lastChecked: new Date().toISOString().slice(0, 10),
  notes: [
    'USD per 1M tokens, Standard tier (Batch / Flex / Priority / Fast / Ultrafast dropped).',
    'Realtime / audio rows resolve to the *text* modality; image-gen rows to the *image* modality.',
    'Per-second (sora) and per-minute (whisper, tts) priced models are intentionally omitted.',
    'Finetuning training rates, tool charges, and gpt-realtime-translate / -whisper minute pricing are dropped.',
    'Generated by scripts/scrape-openai-prices.ts.'
  ],
  prices: sorted
}

const dry = process.argv.includes('--dry')
const serialized = `${JSON.stringify(payload, null, 2)}\n`
if (dry) {
  console.log(serialized)
  console.error(`(dry-run) parsed ${Object.keys(sorted).length} model ids`)
} else {
  writeFileSync(OUT, serialized)
  console.error(`Wrote ${Object.keys(sorted).length} model ids → ${OUT}`)
}

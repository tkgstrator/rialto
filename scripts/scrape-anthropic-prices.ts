#!/usr/bin/env bun
/**
 * Scrape Anthropic's pricing + models overview pages and emit
 * src/shared/data/vendor-prices/anthropic.json.
 *
 *   bun run scripts/scrape-anthropic-prices.ts          # write the JSON
 *   bun run scripts/scrape-anthropic-prices.ts --dry    # print + count only
 *
 * Anthropic splits the pages two ways:
 *   - /docs/en/about-claude/pricing — "Model pricing" table keyed by
 *     display name (Claude Opus 4.7, Claude Sonnet 4.6, …) with
 *     Base Input + Output columns in $ / MTok.
 *   - /docs/en/about-claude/models/overview — "Latest models
 *     comparison" gives display → "Claude API ID" mapping for the
 *     three current frontier rows.
 *
 * For rows whose display name doesn't appear in the comparison table
 * we fall back to a slug rule:
 *   "Claude Opus 4.7"             → claude-opus-4-7
 *   "Claude Opus 4 (deprecated)"  → claude-opus-4-0    (base = -0)
 *   "Claude Haiku 3.5 (retired)"  → claude-3-5-haiku-20241022  (legacy)
 *
 * The legacy 3.x lineage uses a different naming convention so it's
 * hard-coded; if a brand-new "Claude X 3.y" row appears in the
 * pricing table the script will skip it with a warning rather than
 * guess.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OVERVIEW_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview'
const OUT = join(import.meta.dir, '../src/shared/data/providers/anthropic/prices.json')

// Legacy Claude 3.x ids (dated snapshots) keyed by trimmed display
// name. Update when Anthropic publishes more 3.x rows or retires them
// completely.
const LEGACY_IDS: Record<string, string> = {
  'Claude Haiku 3.5': 'claude-3-5-haiku-20241022',
  'Claude Sonnet 3.7': 'claude-3-7-sonnet-20250219',
  'Claude Sonnet 3.5': 'claude-3-5-sonnet-20241022',
  'Claude Haiku 3': 'claude-3-haiku-20240307',
  'Claude Opus 3': 'claude-3-opus-20240229'
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

// --- Step 1: display → API id mapping from the models overview ------------

await page.goto(OVERVIEW_URL, { waitUntil: 'networkidle' })

const overview = await page.evaluate(() => {
  // "Latest models comparison" is the page's first <table>. Each column
  // is a model; row 0 holds the display name (from <th>), other rows
  // are feature/value pairs.
  const t = document.querySelector('table')
  if (!t) return null
  const headerCells = Array.from(t.querySelectorAll('thead tr th')).map((th) => (th.textContent ?? '').trim())
  const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim())
  )
  return { headerCells, rows }
})

// "200K" → 200000, "1M" → 1000000, "200,000 tokens" → 200000. Takes the
// first number so "200K (1M with beta)" resolves to the standard window.
const parseContext = (raw: string): number | null => {
  const m = raw.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)\s*([KM])?/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? '').toUpperCase()
  return Math.round(unit === 'M' ? n * 1e6 : unit === 'K' ? n * 1e3 : n)
}

const displayToApiId: Record<string, string> = {}
const displayToContext: Record<string, number> = {}
if (overview) {
  const apiIdRow = overview.rows.find((r) => /^claude api id$/i.test(r[0] ?? ''))
  // The comparison table also carries a "Context window" feature row.
  const ctxRow = overview.rows.find((r) => /context\s*window/i.test(r[0] ?? ''))
  // headerCells[0] is "Feature"; columns 1..N are display names.
  //
  // The header cell holds the model name and its one-line blurb with no
  // separator once textContent flattens the markup — "Claude Fable
  // 5.1For demanding reasoning and long-horizon agentic work". Keying the
  // maps on that string meant no pricing row ever matched, so the
  // "Context window" feature row was read and then thrown away: every
  // model shipped with a null context. The name ends where the digits do.
  for (let i = 1; i < overview.headerCells.length; i++) {
    const raw = overview.headerCells[i]
    if (!raw) continue
    const named = raw.match(/^(Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)?)/i)
    if (!named) continue
    const display = named[1]
    const apiId = apiIdRow?.[i]
    if (apiId) displayToApiId[display] = apiId
    const ctx = ctxRow ? parseContext(ctxRow[i] ?? '') : null
    if (ctx != null) displayToContext[display] = ctx
  }
}

// --- Step 2: pricing rows from /pricing -----------------------------------

await page.goto(PRICING_URL, { waitUntil: 'networkidle' })

const pricing = await page.evaluate(() => {
  // The first table is the model-pricing table; its second header row
  // carries the leaf columns beneath the grouped Base/Cache headings.
  const t = document.querySelectorAll('table')[0]
  if (!t) return null
  const headerRows = Array.from(t.querySelectorAll('thead tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th')).map((c) => (c.textContent ?? '').trim())
  )
  const headers = headerRows.find((row) => row.some((h) => /^input$|base input/i.test(h)) && row.some((h) => /^output$|output tokens/i.test(h))) ?? []
  const rows = Array.from(t.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent ?? '').trim())
  )
  return { headers, rows }
})

await browser.close()

if (!pricing || pricing.rows.length === 0) {
  console.error('No pricing table found — page layout likely changed. Aborting without overwrite.')
  process.exit(1)
}

// --- Parse helpers --------------------------------------------------------

const parsePrice = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '-' || trimmed === '—') return null
  // Strip "$", "/ MTok" etc.
  const m = trimmed.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/)
  return m ? Number(m[1]) : null
}

// "Claude Opus 4 (deprecated)" → "Claude Opus 4"
const stripStatus = (display: string): string => display.replace(/\s*\([^)]*\)\s*$/, '').trim()

// "Claude Opus 4.7"  → "claude-opus-4-7"
// "Claude Opus 4"    → "claude-opus-4-0"   (.0 implicit on the 4 generation)
// "Claude Opus 5"    → "claude-opus-5"     (no implicit .0 from 5 on)
// "Claude Fable 5.1" → "claude-fable-5-1"
//
// Two things were wrong here and each produced a different failure.
//
// The family list omitted Fable and Mythos, so those rows fell through to
// the "no API id mapping" skip list and never reached the price table at
// all — `claude-fable-5-1` was published on the pricing page and dropped
// on the floor.
//
// The `.0` was appended unconditionally, which invented ids that do not
// exist: the docs list `claude-opus-5` and `claude-sonnet-5`, never
// `claude-opus-5-0`. Naming changed at the 5 generation — an x.0 model
// carries no minor segment — so the implicit zero is correct only for 4.
const claude4PlusSlug = (display: string): string | null => {
  const m = display.match(/^Claude\s+(Opus|Sonnet|Haiku|Fable|Mythos)\s+(\d+)(?:\.(\d+))?$/i)
  if (!m) return null
  const tier = m[1].toLowerCase()
  const major = Number(m[2])
  if (major < 4) return null // legacy lineage handled separately
  if (m[3] !== undefined) return `claude-${tier}-${major}-${m[3]}`
  return major >= 5 ? `claude-${tier}-${major}` : `claude-${tier}-${major}-0`
}

const headerIdx = (label: string): number =>
  pricing.headers.findIndex((h) => h.toLowerCase().includes(label.toLowerCase()))

const inputIdx = pricing.headers.findIndex((h) => /^(base )?input(?: tokens)?$/i.test(h))
const outputIdx = pricing.headers.findIndex((h) => /^output(?: tokens)?$/i.test(h))
// "Cache Hits & Refreshes" is the cached-read rate. Optional: if the
// column is gone we still emit input/output rather than aborting.
const cacheReadIdx = headerIdx('cache hits') >= 0 ? headerIdx('cache hits') : headerIdx('hits and refreshes')

if (inputIdx < 0 || outputIdx < 0) {
  console.error(`Pricing table headers don't match expectation: ${pricing.headers.join(' | ')}`)
  process.exit(1)
}

// --- Reduce to API id → { input, output } ---------------------------------

interface OutEntry {
  input: number
  output: number
  legacy?: boolean
  context?: number
  cachedInput?: number
}

// Display names like "Claude Opus 4 (deprecated)" /
// "Claude Haiku 3.5 (retired, except on Bedrock and Vertex AI)" carry
// the lifecycle status in parens — flag those as legacy.
const isLegacyDisplay = (display: string): boolean => /\((deprecated|retired)[^)]*\)/i.test(display)

const prices: Record<string, OutEntry> = {}
const skipped: string[] = []
for (const row of pricing.rows) {
  const display = row[0]
  if (!display) continue
  const cleaned = stripStatus(display)
  const name = cleaned.match(/^(Claude\s+(?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)?)/i)?.[1] ?? cleaned
  const apiId = displayToApiId[display] ?? displayToApiId[name] ?? claude4PlusSlug(name) ?? LEGACY_IDS[name]
  if (!apiId) {
    skipped.push(display)
    continue
  }
  const input = parsePrice(row[inputIdx] ?? '')
  const output = parsePrice(row[outputIdx] ?? '')
  if (input == null || output == null) {
    skipped.push(`${display} (price parse failed)`)
    continue
  }
  const legacy = isLegacyDisplay(display)
  const context = displayToContext[display] ?? displayToContext[name]
  const cachedInput = cacheReadIdx >= 0 ? parsePrice(row[cacheReadIdx] ?? '') : null
  if (!prices[apiId]) {
    const entry: OutEntry = { input, output }
    if (legacy) entry.legacy = true
    if (context != null) entry.context = context
    if (cachedInput != null) entry.cachedInput = cachedInput
    prices[apiId] = entry
  }
  // For dated Haiku-style ids, also emit the alias so users routing
  // via either form pick the same price.
  if (apiId.includes('-202') || apiId.endsWith('-0')) {
    const aliasMatch = cleaned.toLowerCase().match(/claude\s+(opus|sonnet|haiku)\s+(\d+)(?:\.(\d+))?/i)
    if (aliasMatch) {
      const aliasTier = aliasMatch[1].toLowerCase()
      const aliasMajor = aliasMatch[2]
      const aliasMinor = aliasMatch[3]
      const alias = aliasMinor
        ? `claude-${aliasTier}-${aliasMajor}-${aliasMinor}`
        : `claude-${aliasTier}-${aliasMajor}`
      if (!prices[alias]) {
        const aliasEntry: OutEntry = { input, output }
        if (legacy) aliasEntry.legacy = true
        if (context != null) aliasEntry.context = context
        if (cachedInput != null) aliasEntry.cachedInput = cachedInput
        prices[alias] = aliasEntry
      }
    }
  }
}

if (Object.keys(prices).length === 0) {
  console.error('No prices parsed — schema likely changed. Aborting.')
  process.exit(1)
}

const sorted: Record<string, OutEntry> = {}
for (const id of Object.keys(prices).sort()) sorted[id] = prices[id]

const payload = {
  vendor: 'anthropic',
  source: PRICING_URL,
  lastChecked: new Date().toISOString().slice(0, 10),
  notes: [
    'USD per 1M tokens, Standard tier (cache / batch / fast-mode rows are dropped).',
    'Display → API id mapping is taken from the "Latest models comparison" table at ' + OVERVIEW_URL + '; the remaining rows derive their id by slug rule (claude-{tier}-{major}-{minor}, default minor=0).',
    'Claude 3.x legacy ids are hard-coded in scripts/scrape-anthropic-prices.ts because the lineage uses an older naming pattern.',
    'Generated by scripts/scrape-anthropic-prices.ts.'
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

if (skipped.length > 0) {
  console.error('Skipped (no API id mapping):')
  for (const s of skipped) console.error('  -', s)
}

/**
 * Gemini prices, parsed out of the pricing page's markup.
 *
 * Google publishes no price API, so the figures come from docs HTML —
 * and every way that parse can go wrong is silent. A model the heading
 * filter drops is simply absent from the catalog; a cell read one
 * $-number too far writes an introductory rate's successor, or a cache
 * storage rate, as the token price, and nothing downstream can tell.
 *
 * The fixture is the shape ai.google.dev actually ships: a heading whose
 * `id` is the api id, one <h3>-labelled section per tier, and a
 * (dimension | Free Tier | Paid Tier) table whose paid cell often holds
 * two dated rates.
 */

import { describe, expect, test } from 'bun:test'
import { __testables } from '../../src/vendors/google'

const { collectTables, entryFor, modelIdOf, paidPrice } = __testables

const table = (rows: string): string => `<table class="pricing-table">
  <thead><tr><th></th><th scope="col">Free Tier</th><th scope="col">Paid Tier, per 1M tokens in USD</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`

const row = (dimension: string, free: string, paid: string): string =>
  `<tr><td>${dimension}</td><td>${free}</td><td>${paid}</td></tr>`

const PAGE = `
<div class="heading-group"><h2 id="gemini-3.8-flash" data-text="Gemini 3.8 Flash" tabindex="-1">Gemini 3.8 Flash</h2></div>
<section><h3 id="standard" data-text="Standard">Standard</h3>${table(
  row('Input price', 'Free of charge', '$0.75 through December 31, 2026.<br>$1.50 starting January 1, 2027.') +
    row(
      'Output price (including thinking tokens)',
      'Free of charge',
      '$3.75 through December 31, 2026.<br>$7.50 starting January 1, 2027.'
    ) +
    row(
      'Context caching price',
      'Free of charge',
      '$0.075 through December 31, 2026.<br>$0.50 / 1,000,000 tokens per hour (storage price)'
    ) +
    row('Grounding with Google Search', 'Not available', '5,000 free search requests per month, then $14 per 1,000.')
)}</section>
<section><h3 id="batch" data-text="Batch">Batch</h3>${table(
  row('Input price', 'Not available', '$0.375') + row('Output price', 'Not available', '$1.875')
)}</section>
<div class="heading-group"><h2 id="gemini-embedding-2" data-text="Gemini Embedding">Gemini Embedding</h2></div>
<section>${table(row('Input price', 'Free of charge', '$0.15'))}</section>
<div class="heading-group"><h2 id="veo-3.1" data-text="Veo 3.1">Veo 3.1</h2></div>
<section>${table(row('Input price', 'Not available', '$0.40 / second'))}</section>
<div class="heading-group"><h2 id="pricing-for-tools" data-text="Pricing for tools">Pricing for tools</h2></div>
<section>${table(row('Input price', 'Free of charge', '$1.00'))}</section>
`

type TierTables = ReturnType<typeof collectTables>

const scrapeFixture = (): Map<string, TierTables> => {
  const byId = new Map<string, TierTables>()
  for (const t of collectTables(PAGE)) {
    const bucket = byId.get(t.id)
    if (bucket === undefined) byId.set(t.id, [t])
    else bucket.push(t)
  }
  return byId
}

/** The tables one model owns, or none — the scrape's own view of a page. */
const tablesFor = (id: string): TierTables => {
  const found = scrapeFixture().get(id)
  return found === undefined ? [] : found
}

describe('modelIdOf', () => {
  test('takes the api id off the heading, not the display name', () => {
    // "Gemini 3.8 Flash" is not routable; `gemini-3.8-flash` is.
    expect(modelIdOf(' id="gemini-3.8-flash" data-text="Gemini 3.8 Flash" tabindex="-1"')).toBe('gemini-3.8-flash')
  })

  test('skips the families that are not token-billed models', () => {
    expect(modelIdOf(' id="veo-3.1"')).toBeNull()
    expect(modelIdOf(' id="lyria-3"')).toBeNull()
    expect(modelIdOf(' id="gemma-4"')).toBeNull()
  })

  test('skips a heading with no id at all', () => {
    expect(modelIdOf(' class="prose"')).toBeNull()
  })
})

describe('paidPrice', () => {
  test('takes the rate in force, not the one that replaces it', () => {
    expect(paidPrice('$0.75 through December 31, 2026. $1.50 starting January 1, 2027.')).toBe(0.75)
  })

  test('takes the per-token rate ahead of the storage rate beside it', () => {
    expect(paidPrice('$0.075 through December 31, 2026. $0.50 / 1,000,000 tokens per hour (storage price)')).toBe(0.075)
  })

  test('a cell with digits but no price is not a price', () => {
    // Both of these carry numbers a bare number-grab would have taken.
    expect(paidPrice('Free of charge')).toBeNull()
    expect(paidPrice('Not available')).toBeNull()
    expect(paidPrice(undefined)).toBeNull()
  })
})

describe('scraping the page', () => {
  test('prices a model off its Standard table, not the half-price Batch one', () => {
    const entry = entryFor('gemini-3.8-flash', tablesFor('gemini-3.8-flash'))
    expect(entry).toEqual({
      apiId: 'gemini-3.8-flash',
      inputPer1M: 0.75,
      outputPer1M: 3.75,
      cachedInputPer1M: 0.075,
      contextWindow: null,
      legacy: false
    })
  })

  test('drops a model that prices input and has no output row', () => {
    // An embedding model. Half a price pair is worse than none: the row
    // would read as a complete, very cheap model.
    expect(entryFor('gemini-embedding-2', tablesFor('gemini-embedding-2'))).toBeNull()
  })

  test('never opens a section for a non-model heading', () => {
    const ids = [...scrapeFixture().keys()]
    expect(ids).toEqual(['gemini-3.8-flash', 'gemini-embedding-2'])
    // `pricing-for-tools` has a table shaped exactly like a model's, and
    // an id that starts with neither "gemini-" nor a digit.
    expect(ids).not.toContain('pricing-for-tools')
    expect(ids).not.toContain('veo-3.1')
  })

  test('a table before any heading belongs to no model', () => {
    expect(collectTables(table(row('Input price', 'Free of charge', '$1.00')))).toEqual([])
  })
})

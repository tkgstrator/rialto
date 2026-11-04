/**
 * OpenAI prices, read out of the pricing page's markup.
 *
 * `gpt-6-astra` never showed up under the API-key OpenAI provider because
 * the scrape returned nothing: the page put "Output" ahead of "Cached
 * input", the reader demanded the opposite order, and the failure was a
 * single warning line. Every way this parse can go wrong is silent
 * downstream — a missing model is simply absent from the catalog, and a
 * column read one cell off writes the 30m cache-write rate as the output
 * price (which is what the committed `gpt-5.6-*` seed rows had come to say).
 *
 * Two layouts are pinned:
 *   - the current one, as a trimmed copy of the real page (see the comment
 *     at the top of the fixture for what was cut);
 *   - the one before it, rebuilt from what the previous reader assumed
 *     (a Short context / Long context super-header over a repeated
 *     Input / Cached input / Output triple, and no tier labels). No capture
 *     of that page survives, so this one is written by hand.
 *
 * Nothing here touches the network.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadVendorCatalogs } from '../../src/services/model-sync-catalog'
import { buildCreateRow } from '../../src/services/model-sync-service'
import { OFFICIAL_VENDOR_PRICES } from '../../src/shared/data'
import { OpenAIProvider } from '../../src/vendors/openai'
import { columnsOf, findPricingTables, pickStandard, readPriceRow } from '../../src/vendors/openai/pricing-table'

const CURRENT_PAGE = readFileSync(join(import.meta.dir, '../fixtures/openai-pricing/pricing-2026-11.html'), 'utf8')

const originalFetch = globalThis.fetch
afterEach(() => {
  Reflect.set(globalThis, 'fetch', originalFetch)
})

const scrapeOf = async (html: string) => {
  Reflect.set(globalThis, 'fetch', async () => new Response(html, { status: 200 }))
  return new OpenAIProvider().scrape()
}

const priced = (apiId: string, inputPer1M: number, outputPer1M: number, cachedInputPer1M: number | null) => ({
  apiId,
  inputPer1M,
  outputPer1M,
  cachedInputPer1M,
  contextWindow: null,
  legacy: false
})

const rowOf = (tag: 'th' | 'td', values: readonly string[]): string =>
  `<tr>${values.map((v) => `<${tag}>${v}</${tag}>`).join('')}</tr>`

const tableOf = (header: readonly string[], rows: readonly (readonly string[])[], lead = ''): string =>
  `<table><thead>${lead}${rowOf('th', header)}</thead><tbody>${rows.map((r) => rowOf('td', r)).join('')}</tbody></table>`

const labelled = (tier: string, inner: string): string =>
  `<astro-island props="{&quot;tier&quot;:[0,&quot;${tier}&quot;]}"><div>${inner}</div></astro-island>`

describe('columnsOf', () => {
  test('finds the columns of the current header by name', () => {
    expect(columnsOf(['Model', 'Input', 'Output', 'Cached input', '30m write', '12h write'])).toEqual({
      model: 0,
      input: 1,
      output: 2,
      cachedInput: 3
    })
  })

  test('does not care what order the columns come in', () => {
    expect(columnsOf(['Cached input', '12h write', 'Output', 'Model', 'Input'])).toEqual({
      model: 3,
      input: 4,
      output: 2,
      cachedInput: 0
    })
  })

  test('takes the short-context block when the long-context block repeats the columns', () => {
    expect(columnsOf(['Model', 'Input', 'Cached input', 'Output', 'Input', 'Cached input', 'Output'])).toEqual({
      model: 0,
      input: 1,
      output: 3,
      cachedInput: 2
    })
  })

  test('never points at a cache-write column', () => {
    const cols = columnsOf(['Model', '30m write', 'Input', '12h write', 'Output', 'Cached input'])
    expect(cols).toEqual({ model: 0, input: 2, output: 4, cachedInput: 5 })
  })

  test.each([
    ['a Modality column (realtime, image)', ['Model', 'Modality', 'Input', 'Output', 'Cached input']],
    ['a Training column (fine-tuning)', ['Model', 'Training', 'Input', 'Output', 'Cached input']],
    ['a Category column (codex, chat)', ['Category', 'Model', 'Input', 'Output', 'Cached input']],
    ['"Model configuration" for "Model" (legal)', ['Model configuration', 'Input', 'Output', 'Cached input']],
    ['the spanned super-header row', ['', 'Prompt caching']],
    ['a missing Cached input', ['Model', 'Input', 'Output']]
  ])('is not the flagship header with %s', (_label, header) => {
    expect(columnsOf(header)).toBeNull()
  })
})

describe('readPriceRow', () => {
  const cols = { model: 0, input: 1, output: 2, cachedInput: 3 }

  test('reads the three rates from their columns, not their positions', () => {
    expect(readPriceRow(['gpt-6-astra', '$10.00', '$50.00', '$1.00', '$12.50', '$25.00'], cols)).toEqual({
      apiId: 'gpt-6-astra',
      inputPer1M: 10,
      outputPer1M: 50,
      cachedInputPer1M: 1
    })
  })

  test('keeps a model that has no cache discount, with the rate left empty', () => {
    expect(readPriceRow(['gpt-5.5-pro', '$30.00', '$180.00', '-'], cols)?.cachedInputPer1M).toBeNull()
  })

  test('keeps only the id of a row annotated with its context bracket', () => {
    expect(readPriceRow(['gpt-5.5 (<272K context length)', '$5.00', '$30.00', '$0.50'], cols)?.apiId).toBe('gpt-5.5')
  })

  test('skips a row with no input or output rate', () => {
    expect(readPriceRow(['gpt-x', '-', '$1.00', '$0.10'], cols)).toBeNull()
    expect(readPriceRow(['gpt-x', '$1.00', '-', '$0.10'], cols)).toBeNull()
    expect(readPriceRow(['', '$1.00', '$2.00', '$0.10'], cols)).toBeNull()
  })
})

describe('the current page (trimmed copy of the real one)', () => {
  test('finds the five tier tables and none of the neighbours that share column names', () => {
    expect(findPricingTables(CURRENT_PAGE).map((t) => t.tier)).toEqual([
      'standard',
      'batch',
      'fast',
      'ultrafast',
      'standard'
    ])
  })

  test('picks the Standard tables, including the model-group one after the last tier tab', () => {
    const standard = pickStandard(findPricingTables(CURRENT_PAGE))
    expect(standard.map((t) => t.rows.map((r) => r[0]))).toEqual([
      ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'],
      ['gpt-5.6-sol', 'gpt-5.6-cyber']
    ])
  })

  test('scrapes gpt-6-astra and the rest of the Standard lineup at their short-context rates', async () => {
    expect(await scrapeOf(CURRENT_PAGE)).toEqual([
      priced('gpt-6-astra', 10, 50, 1),
      priced('gpt-6.1-sol', 2, 10, 0.1),
      priced('gpt-6.1-terra', 1, 5, 0.05),
      priced('gpt-6-luna', 0.1, 0.5, 0.01),
      priced('gpt-5.6-sol', 4, 20, 0.4),
      priced('gpt-5.6-cyber', 12.5, 75, 1.25)
    ])
  })

  test('does not take the 30m cache-write rate for the output price', async () => {
    const astra = (await scrapeOf(CURRENT_PAGE)).find((e) => e.apiId === 'gpt-6-astra')
    expect(astra?.outputPer1M).toBe(50)
    expect(astra?.outputPer1M).not.toBe(12.5)
  })

  test('does not take a price from the Batch, Fast or Ultrafast table', async () => {
    const astra = (await scrapeOf(CURRENT_PAGE)).filter((e) => e.apiId === 'gpt-6-astra')
    // Batch 5, Fast 20, Ultrafast 60 for the same model on the same page.
    expect(astra.map((e) => e.inputPer1M)).toEqual([10])
  })

  test('leaves out the tables that only look like it', async () => {
    const ids = (await scrapeOf(CURRENT_PAGE)).map((e) => e.apiId)
    expect(ids).not.toContain('gpt-6-astra-law')
    expect(ids).not.toContain('gpt-realtime-2.1')
    expect(ids).not.toContain('gpt-4.1-2025-04-14')
  })
})

describe('the layout before the tier labels', () => {
  const OLD_HEADER = ['Model', 'Input', 'Cached input', 'Output', 'Input', 'Cached input', 'Output']
  const SUPER_HEADER = '<tr><th></th><th colspan="3">Short context</th><th colspan="3">Long context</th></tr>'
  // Short-context and long-context rates differ on purpose, so reading the wrong block shows.
  const standard = tableOf(
    OLD_HEADER,
    [
      ['gpt-5.5 (<272K context length)', '$5.00', '$0.50', '$30.00', '$10.00', '$1.00', '$45.00'],
      ['gpt-5.4-mini', '$0.75', '$0.075', '$4.50', '$1.50', '$0.15', '$6.75']
    ],
    SUPER_HEADER
  )
  const batch = tableOf(
    OLD_HEADER,
    [['gpt-5.5 (<272K context length)', '$2.50', '$0.25', '$15.00', '$5.00', '$0.50', '$22.50']],
    SUPER_HEADER
  )
  const page = `<h2>Standard</h2>${standard}<h2>Batch</h2>${batch}`

  test('has no tier labels, so every table is unlabelled', () => {
    expect(findPricingTables(page).map((t) => t.tier)).toEqual([null, null])
  })

  test('takes the first table as Standard and its short-context columns', async () => {
    expect(await scrapeOf(page)).toEqual([priced('gpt-5.5', 5, 30, 0.5), priced('gpt-5.4-mini', 0.75, 4.5, 0.075)])
  })
})

describe('column order', () => {
  const header = ['Model', 'Input', 'Output', 'Cached input', '30m write', '12h write']
  const rows = [
    ['gpt-6-astra', '$10.00', '$50.00', '$1.00', '$12.50', '$25.00'],
    ['gpt-6-luna', '$0.10', '$0.50', '$0.01', '$0.125', '$0.25']
  ]
  const expected = [priced('gpt-6-astra', 10, 50, 1), priced('gpt-6-luna', 0.1, 0.5, 0.01)]
  const permute = (values: readonly string[], order: readonly number[]): string[] => order.map((i) => values[i])

  test.each([
    [[0, 1, 2, 3, 4, 5]],
    [[0, 1, 3, 2, 4, 5]],
    [[5, 4, 3, 2, 1, 0]],
    [[2, 5, 0, 3, 1, 4]],
    [[0, 4, 5, 1, 3, 2]]
  ])('reads the same prices with the columns in order %p', async (order) => {
    const html = labelled(
      'standard',
      tableOf(
        permute(header, order),
        rows.map((r) => permute(r, order))
      )
    )
    expect(await scrapeOf(html)).toEqual(expected)
  })

  test('finds the header row wherever it sits among the leading rows', async () => {
    const lead = '<tr><th colspan="2">Pricing</th></tr><tr><th></th><th colspan="5">Prompt caching</th></tr>'
    expect(await scrapeOf(labelled('standard', tableOf(header, rows, lead)))).toEqual(expected)
  })
})

describe('when the page cannot be read', () => {
  const header = ['Model', 'Input', 'Output', 'Cached input']
  const rows = [['gpt-6-astra', '$10.00', '$50.00', '$1.00']]

  test('returns nothing for a page with no tables', async () => {
    expect(await scrapeOf('<html><body><p>Pricing</p></body></html>')).toEqual([])
  })

  test('returns nothing when the page labels its tiers and none of them is Standard', async () => {
    const html = labelled('batch', tableOf(header, rows)) + labelled('fast', tableOf(header, rows))
    expect(await scrapeOf(html)).toEqual([])
  })

  test('returns nothing rather than guessing when a new column appears in the header', async () => {
    const html = labelled(
      'standard',
      tableOf(
        ['Model', 'Region', 'Input', 'Output', 'Cached input'],
        [['gpt-6-astra', 'EU', '$11.00', '$55.00', '$1.10']]
      )
    )
    expect(await scrapeOf(html)).toEqual([])
  })

  test('returns nothing for a failed fetch', async () => {
    Reflect.set(globalThis, 'fetch', async () => new Response('nope', { status: 503 }))
    expect(await new OpenAIProvider().scrape()).toEqual([])
  })
})

describe('from the scrape to a Model row', () => {
  const provider = (authMode: 'api_key' | 'subscription') => ({
    id: 'p1',
    name: 'openai',
    apiKey: authMode === 'api_key' ? 'sk' : null,
    authMode,
    models: []
  })

  const catalogOf = async () => {
    Reflect.set(globalThis, 'fetch', async () => new Response(CURRENT_PAGE, { status: 200 }))
    const catalogs = await loadVendorCatalogs(new Set(['openai']))
    const catalog = catalogs.get('openai')
    if (catalog === undefined) throw new Error('no openai catalog was loaded')
    return catalog
  }

  test('gpt-6-astra is listed, and lands as a switched-off row that nothing marks legacy or deprecated', async () => {
    const catalog = await catalogOf()
    expect(catalog.listed.map((e) => e.apiId)).toContain('gpt-6-astra')
    expect(buildCreateRow('gpt-6-astra', provider('api_key'), catalog.priceById.get('gpt-6-astra'))).toMatchObject({
      name: 'gpt-6-astra',
      enabled: false,
      legacy: false,
      deprecated: false,
      inputPer1M: 10,
      outputPer1M: 50,
      cachedInputPer1M: 1
    })
  })

  // The table shows only the newest models. The ones it leaves out are
  // priced from the committed seed, so the seed has to carry the output
  // rate and not the cache-write rate that sits beside it on the page.
  test('a model the table does not show is priced from the committed seed, not left blank', async () => {
    const catalog = await catalogOf()
    expect(catalog.listed.map((e) => e.apiId)).not.toContain('gpt-5.6-terra')
    expect(catalog.priceById.get('gpt-5.6-terra')).toMatchObject({
      inputPer1M: 2,
      outputPer1M: 12,
      cachedInputPer1M: 0.2,
      contextWindow: 1_050_000
    })
  })

  // The window is not on the pricing page. A scraped id carries none (the
  // scrape wins over the seed for ids it answers) and gets it afterwards from
  // the model's docs page; the seed is where an id the scrape does not
  // answer gets one, and where the catalog view starts from.
  test.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'])(
    'the committed seed prices %s and records its window',
    (id) => {
      const seeded = OFFICIAL_VENDOR_PRICES.openai[id]
      expect(seeded.inputPer1M).toBeGreaterThan(0)
      expect(seeded.outputPer1M).toBeGreaterThan(seeded.inputPer1M)
      expect(seeded.contextWindow).toBeGreaterThan(0)
      expect(seeded.legacy).toBeUndefined()
    }
  )
})

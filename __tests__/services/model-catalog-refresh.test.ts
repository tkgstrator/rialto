/**
 * The two sources a catalog refresh reads, and the credential that lets
 * it read them.
 *
 * Both halves here are the same shape of bug: Rialto held the answer, or
 * could have asked for it, and the refresh returned nothing anyway.
 *
 *  1. Prices came from the live scrape OR the committed table, never
 *     both. When OpenAI's docs moved and its scrape fell to three
 *     models, a refresh priced three rows and left fifteen null — with
 *     the published figures for all eighteen already committed.
 *  2. Context windows came from the vendor's catalog endpoint, which a
 *     subscription provider could never call: it has no api key, so the
 *     fetch returned early. Anthropic publishes the figure per model as
 *     `max_input_tokens`, and the OAuth access token the request path
 *     already uses is accepted on that endpoint.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { buildCreateRow, withCommittedPrices } from '../../src/services/model-sync-service'
import { AnthropicProvider } from '../../src/vendors/anthropic'
import type { ScrapedPriceEntry } from '../../src/vendors/base'

const entry = (apiId: string, inputPer1M: number, contextWindow: number | null = null): ScrapedPriceEntry => ({
  apiId,
  inputPer1M,
  outputPer1M: inputPer1M * 5,
  cachedInputPer1M: null,
  contextWindow,
  legacy: false
})

const committedOf = (entries: ScrapedPriceEntry[]) => ({
  listed: entries,
  priceById: new Map(entries.map((e) => [e.apiId, e]))
})

describe('withCommittedPrices', () => {
  test('the committed table fills ids the scrape did not mention', () => {
    const merged = withCommittedPrices([entry('gpt-5', 1)], committedOf([entry('gpt-5', 9), entry('o3', 2)]))
    expect(merged.priceById.get('o3')?.inputPer1M).toBe(2)
  })

  test('a live price wins over the committed one — the fresher source is the point of a refresh', () => {
    const merged = withCommittedPrices([entry('gpt-5', 1)], committedOf([entry('gpt-5', 9)]))
    expect(merged.priceById.get('gpt-5')?.inputPer1M).toBe(1)
  })

  test('the committed table never adds a listed id', () => {
    // `listed` decides which Model rows exist. Merging the table into it
    // grew 43 api_key OpenAI models on a Codex subscription: a price list
    // is not a statement about what a provider serves.
    const merged = withCommittedPrices([entry('gpt-5', 1)], committedOf([entry('gpt-5', 9), entry('o3', 2)]))
    expect(merged.listed.map((e) => e.apiId)).toEqual(['gpt-5'])
  })

  test('no committed table leaves the scrape untouched', () => {
    const merged = withCommittedPrices([entry('gpt-5', 1)], undefined)
    expect(merged.listed).toHaveLength(1)
    expect(merged.priceById.size).toBe(1)
  })

  test('an empty scrape still yields every committed price', () => {
    // The OpenAI case exactly: the scrape found nothing, and every price
    // has to come from the table or the refresh accomplishes nothing.
    const merged = withCommittedPrices([], committedOf([entry('gpt-5', 9), entry('o3', 2)]))
    expect(merged.priceById.size).toBe(2)
    expect(merged.listed).toHaveLength(0)
  })
})

describe('fetchContextWindows credentials', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const captureHeaders = (body: unknown): { seen: { headers: Record<string, string> | null } } => {
    const seen: { headers: Record<string, string> | null } = { headers: null }
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h: Record<string, string> = {}
      for (const [k, v] of Object.entries(init?.headers ?? {})) h[k.toLowerCase()] = String(v)
      seen.headers = h
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { seen }
  }

  test('an api_key credential keeps the vendor scheme', async () => {
    const { seen } = captureHeaders({ data: [{ id: 'claude-opus-4-1', max_input_tokens: 200000 }] })
    await new AnthropicProvider().fetchContextWindows(['claude-opus-4-1'], { kind: 'api_key', key: 'sk-ant' })
    expect(seen.headers?.['x-api-key']).toBe('sk-ant')
    expect(seen.headers?.authorization).toBeUndefined()
  })

  test('no credential makes no request at all', async () => {
    const { seen } = captureHeaders({ data: [] })
    const got = await new AnthropicProvider().fetchContextWindows(['claude-opus-4-1'], undefined)
    expect(seen.headers).toBeNull()
    expect(got.size).toBe(0)
  })

  test('only ids the caller holds a row for come back', async () => {
    captureHeaders({
      data: [
        { id: 'claude-opus-4-1', max_input_tokens: 200000 },
        { id: 'claude-sonnet-9', max_input_tokens: 999 }
      ]
    })
    const got = await new AnthropicProvider().fetchContextWindows(['claude-opus-4-1'], {
      kind: 'api_key',
      key: 'sk-ant'
    })
    expect([...got.keys()]).toEqual(['claude-opus-4-1'])
  })
})

describe('a model a refresh finds', () => {
  // A tier follows the newest switched-on model its name says, so a row
  // that landed on would move a route the moment a vendor published it.
  test('lands switched off on every provider', () => {
    const provider = (authMode: 'api_key' | 'subscription') => ({
      id: 'p1',
      name: authMode === 'api_key' ? 'anthropic' : 'claude-code',
      apiKey: authMode === 'api_key' ? 'sk-ant' : null,
      authMode,
      models: []
    })
    expect(buildCreateRow('claude-sonnet-5-5', provider('api_key'), entry('claude-sonnet-5-5', 3)).enabled).toBe(false)
    expect(buildCreateRow('claude-sonnet-5-5', provider('subscription'), undefined).enabled).toBe(false)
  })

  // The scrape describes the vendor's API; a subscription row takes its
  // window from the subscription's own list, recorded once
  // (model-capability-service), so the scraped figure must not land first.
  test('takes the scraped price but not the scraped window on a subscription provider', () => {
    const provider = (authMode: 'api_key' | 'subscription') => ({
      id: 'p1',
      name: authMode === 'api_key' ? 'openai' : 'codex',
      apiKey: authMode === 'api_key' ? 'sk' : null,
      authMode,
      models: []
    })
    const scraped = entry('gpt-6-sol', 3, 1_050_000)
    expect(buildCreateRow('gpt-6-sol', provider('api_key'), scraped).contextWindow).toBe(1_050_000)
    const subscription = buildCreateRow('gpt-6-sol', provider('subscription'), scraped)
    expect(subscription.contextWindow).toBeNull()
    expect(subscription.inputPer1M).toBe(3)
  })
})

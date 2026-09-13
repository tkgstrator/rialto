/**
 * The Gemini transformer's two outbound entry points.
 *
 * A Gemini client talking to a Gemini provider takes the pipeline's
 * bypass path: no conversion is needed, so only `auth` runs. That hook
 * carries the whole burden of turning a request into a valid Google
 * call, and two of its jobs are easy to get silently wrong:
 *
 *   - the model and action have to go back into the URL, because
 *     `api_base_url` only names the collection they hang off. Before
 *     this hook existed the bypass path POSTed to `.../v1beta/models/`
 *     and Google answered 404.
 *   - `model` / `stream` have to come back OUT of the body. The route
 *     folds them in so the router and pipeline can read them; Google
 *     rejects unknown top-level fields with INVALID_ARGUMENT.
 */

import { describe, expect, test } from 'bun:test'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { buildTools } from '../../src/llms/utils/gemini/request-config'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../src/schemas/domain'

const provider = (apiBaseUrl: string): RuntimeProvider =>
  ({
    name: 'google',
    api_base_url: apiBaseUrl,
    api_key: 'provider-key',
    models: ['gemini-3-pro']
  }) as RuntimeProvider

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/'
const context = {} as TransformerContext

describe('GeminiTransformer.auth (bypass path)', () => {
  const transformer = new GeminiTransformer()

  test('builds the generateContent URL from the model on the body', async () => {
    const result = await transformer.auth({ model: 'gemini-3-pro', contents: [] }, provider(BASE), context)
    const config = (result as { config: { url: URL } }).config
    expect(String(config.url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent'
    )
  })

  test('a streaming request asks for SSE explicitly', async () => {
    const result = await transformer.auth(
      { model: 'gemini-3-pro', stream: true, contents: [] },
      provider(BASE),
      context
    )
    const url = (result as { config: { url: URL } }).config.url
    expect(url.pathname).toBe('/v1beta/models/gemini-3-pro:streamGenerateContent')
    // Without alt=sse Google streams a JSON array, not an SSE stream,
    // and the relay would hand the client something it cannot parse.
    expect(url.searchParams.get('alt')).toBe('sse')
  })

  test('a base URL missing its trailing slash still resolves under models/', async () => {
    // `new URL('./x', '.../v1beta/models')` resolves against the parent
    // and silently drops the collection segment.
    const result = await transformer.auth(
      { model: 'gemini-3-pro', contents: [] },
      provider('https://generativelanguage.googleapis.com/v1beta/models'),
      context
    )
    expect((result as { config: { url: URL } }).config.url.pathname).toBe('/v1beta/models/gemini-3-pro:generateContent')
  })

  test('the route-injected fields are removed from the outbound body', async () => {
    const result = await transformer.auth(
      { model: 'gemini-3-pro', stream: true, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      provider(BASE),
      context
    )
    const body = (result as { body: Record<string, unknown> }).body
    expect(body.model).toBeUndefined()
    expect(body.stream).toBeUndefined()
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  test('the caller does not see its own body mutated', async () => {
    // The chain walker reuses the plan body across failover attempts;
    // stripping fields in place would break the second attempt.
    const original: Record<string, unknown> = { model: 'gemini-3-pro', stream: true, contents: [] }
    await transformer.auth(original, provider(BASE), context)
    expect(original.model).toBe('gemini-3-pro')
    expect(original.stream).toBe(true)
  })

  test("the provider's key replaces whatever the client presented", async () => {
    const result = await transformer.auth({ model: 'gemini-3-pro', contents: [] }, provider(BASE), context)
    const headers = (result as { config: { headers: Record<string, string | undefined> } }).config.headers
    expect(headers['x-goog-api-key']).toBe('provider-key')
    // Google 401s when both are present; the Bearer the pipeline sets by
    // default has to be cleared.
    expect(headers.Authorization).toBeUndefined()
  })

  test('a body with no model still produces a URL rather than throwing', async () => {
    // The upstream 404 that follows is a better diagnostic than a 500
    // from inside the transformer.
    const result = await transformer.auth({ contents: [] }, provider(BASE), context)
    expect((result as { config: { url: URL } }).config.url.pathname).toBe('/v1beta/models/:generateContent')
  })
})

describe('GeminiTransformer.transformRequestIn (converted path)', () => {
  test('builds the same URL shape from the unified request', async () => {
    // The two hooks must not drift: a Gemini provider reached through
    // conversion has to be called at the same endpoint as one reached
    // through bypass.
    const transformer = new GeminiTransformer()
    const unified = { model: 'gemini-3-pro', messages: [], stream: true } as unknown as UnifiedChatRequest
    const result = await transformer.transformRequestIn(unified, provider(BASE), context)
    const url = (result as { config: { url: URL } }).config.url
    expect(url.pathname).toBe('/v1beta/models/gemini-3-pro:streamGenerateContent')
    expect(url.searchParams.get('alt')).toBe('sse')
  })
})

describe('buildTools — tools Gemini cannot declare', () => {
  test('drops a tool carrying no function object and keeps the rest', () => {
    // Gemini declares tools by function signature; Codex's `custom` and
    // `local_shell` have none, so there is nothing to declare. Dropping
    // them is the only honest answer — before the unified tool type
    // admitted them, reading their name crashed the request instead.
    expect(
      buildTools([
        { type: 'custom', name: 'shell', description: 'Run a shell command' },
        { type: 'local_shell' },
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up weather',
            parameters: { type: 'object', properties: {} }
          }
        }
      ])
    ).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Look up weather',
            parametersJsonSchema: { type: 'object', properties: {} }
          }
        ]
      }
    ])
  })

  test('a hosted web_search alongside them still asks for googleSearch', () => {
    expect(
      buildTools([
        { type: 'local_shell' },
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Hosted web search',
            parameters: { type: 'object', properties: {} }
          }
        }
      ])
    ).toEqual([{ googleSearch: {} }])
  })
})

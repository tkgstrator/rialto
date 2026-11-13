/**
 * Where the two OpenAI provider steps send a request, given the Base URL the
 * operator stored.
 *
 * The Base URL of an api_key OpenAI provider may name `/chat/completions` or
 * `/responses`. The Chat step sends Chat requests to the first, the
 * Responses step sends Responses requests to the second, and a URL that
 * names neither is left alone (the Codex backend root is one: codex-oauth
 * appends its own `/responses`). A model served over Responses has a chain
 * of its own after the provider's, and the Chat step has to stand aside for
 * it so that chain gets the body still unified.
 */

import { describe, expect, test } from 'bun:test'
import { OpenAITransformer } from '../../../src/llms/transformers/openai/endpoint-chat'
import { OpenAIResponsesTransformer } from '../../../src/llms/transformers/openai/endpoint-responses'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../../src/schemas/domain'

const provider = (baseUrl: string, extra: Partial<RuntimeProvider> = {}): RuntimeProvider => ({
  name: 'openai',
  api_base_url: baseUrl,
  api_key: 'sk-test',
  ...extra
})

// The steps mutate what they are given and read fields the unified type does
// not list (`max_completion_tokens`), so the extras are assigned on as-is.
const unified = (extra: Record<string, unknown> = {}): UnifiedChatRequest =>
  Object.assign({ model: 'gpt-6-astra', messages: [{ role: 'user' as const, content: 'ping' }] }, extra)

const context: TransformerContext = {}

// A step returns the body, or a hook wrapping it with the config it adds.
const urlOf = (result: unknown): unknown => {
  const r = Object(result)
  return 'config' in r ? Object(r.config).url : undefined
}
const bodyOf = (result: unknown): Record<string, unknown> => {
  const r = Object(result)
  return 'body' in r ? Object(r.body) : r
}

const CHAT = 'https://api.openai.com/v1/chat/completions'
const RESPONSES = 'https://api.openai.com/v1/responses'

describe('OpenAITransformer (Chat step)', () => {
  const t = new OpenAITransformer()

  test('a Chat Base URL needs no URL from the step', async () => {
    const result = await t.transformRequestIn(unified(), provider(CHAT), context)
    expect(urlOf(result)).toBeUndefined()
    // Still the plain body: nothing else was added to it.
    expect('config' in Object(result)).toBe(false)
  })

  test('a Responses Base URL is sent to /chat/completions', async () => {
    const result = await t.transformRequestIn(unified(), provider(RESPONSES), context)
    expect(urlOf(result)).toBe(CHAT)
    expect(bodyOf(result).model).toBe('gpt-6-astra')
  })

  test('keeps the query and trailing slash while swapping', async () => {
    const result = await t.transformRequestIn(unified(), provider(`${RESPONSES}/?api-version=1`), context)
    expect(urlOf(result)).toBe(`${CHAT}/?api-version=1`)
  })

  test('a Base URL naming neither endpoint is left as stored', async () => {
    const result = await t.transformRequestIn(unified(), provider('https://proxy.example/v1/foo'), context)
    expect(urlOf(result)).toBeUndefined()
  })

  test('still shapes the body for a Chat model', async () => {
    const result = await t.transformRequestIn(
      unified({ max_tokens: 64, reasoning: { effort: 'high' } }),
      provider(RESPONSES),
      context
    )
    const body = bodyOf(result)
    expect(body.max_completion_tokens).toBe(64)
    expect('max_tokens' in body).toBe(false)
    expect(body.reasoning_effort).toBe('high')
    expect('reasoning' in body).toBe(false)
  })

  test('stands aside for a model that has a chain of its own', async () => {
    // The model is served over Responses: its own step runs after this one
    // and reads `reasoning`, which the Chat shaping would have deleted.
    const own = provider(CHAT, {
      transformer: { 'gpt-6-astra': { use: [new OpenAIResponsesTransformer()] } }
    })
    const request = unified({ max_tokens: 64, reasoning: { effort: 'high' } })
    const result = await t.transformRequestIn(request, own, context)
    expect(result).toBe(request)
    const body = bodyOf(result)
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(64)
    expect('reasoning_effort' in body).toBe(false)
    expect('max_completion_tokens' in body).toBe(false)
  })

  test('another model of the same provider is still shaped', async () => {
    const own = provider(CHAT, {
      transformer: { 'gpt-6-astra': { use: [new OpenAIResponsesTransformer()] } }
    })
    const result = await t.transformRequestIn(unified({ model: 'gpt-5-mini', max_tokens: 8 }), own, context)
    expect(bodyOf(result).max_completion_tokens).toBe(8)
  })

  describe('bypass auth hook', () => {
    test('a Chat Base URL passes the body through untouched', async () => {
      const body = { model: 'gpt-5-mini', messages: [] }
      expect(await t.auth(body, provider(CHAT), context)).toBe(body)
    })

    test('a Responses Base URL gets its URL corrected, body unchanged', async () => {
      const body = { model: 'gpt-5-mini', messages: [] }
      const result = await t.auth(body, provider(RESPONSES), context)
      expect(urlOf(result)).toBe(CHAT)
      expect(bodyOf(result)).toBe(body)
    })
  })
})

describe('OpenAIResponsesTransformer (Responses step)', () => {
  const t = new OpenAIResponsesTransformer()

  test('a Chat Base URL is sent to /responses', async () => {
    const result = await t.transformRequestIn(unified(), provider(CHAT))
    expect(urlOf(result)).toBe(RESPONSES)
    expect(bodyOf(result).input).toEqual([{ role: 'user', content: 'ping' }])
  })

  test('a Responses Base URL needs no URL from the step', async () => {
    const result = await t.transformRequestIn(unified(), provider(RESPONSES))
    expect(urlOf(result)).toBeUndefined()
    expect('config' in Object(result)).toBe(false)
  })

  test('keeps the query and trailing slash while swapping', async () => {
    const result = await t.transformRequestIn(unified(), provider(`${CHAT}/?api-version=1`))
    expect(urlOf(result)).toBe(`${RESPONSES}/?api-version=1`)
  })

  test('the Codex backend root is left alone for codex-oauth to complete', async () => {
    const result = await t.transformRequestIn(unified(), provider('https://chatgpt.com/backend-api/codex'))
    expect(urlOf(result)).toBeUndefined()
  })

  test('a provider-less call has no URL to correct', async () => {
    const result = await t.transformRequestIn(unified())
    expect(urlOf(result)).toBeUndefined()
  })

  test('run after the Chat step, a Responses model keeps its effort as the reasoning object', async () => {
    const own = provider(CHAT, {
      transformer: { 'gpt-6-astra': { use: [t] } }
    })
    const afterChat = await new OpenAITransformer().transformRequestIn(
      unified({ max_tokens: 64, reasoning: { effort: 'high' } }),
      own,
      context
    )
    const result = await t.transformRequestIn(unified({ ...bodyOf(afterChat) }), own)
    const body = bodyOf(result)
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
    expect(body.max_output_tokens).toBe(64)
    expect('reasoning_effort' in body).toBe(false)
    expect(urlOf(result)).toBe(RESPONSES)
  })
})

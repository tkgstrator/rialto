/**
 * The Base URL of an OpenAI provider may name either endpoint, and each
 * request is sent to the one its model's wire format needs.
 *
 * `retargetOpenAIUrl` is the single place that swaps the tail; the send path
 * (the Chat and Responses steps) and the model probe all read it, so these
 * cases pin the shapes they have to survive: a trailing slash, a query, a
 * URL already on the target, and one that names neither endpoint.
 */

import { describe, expect, test } from 'bun:test'
import { redirectedOpenAIUrl, retargetOpenAIUrl } from '../../src/llms/utils/openai-endpoint'

const chat = 'https://api.openai.com/v1/chat/completions'
const responses = 'https://api.openai.com/v1/responses'

describe('retargetOpenAIUrl', () => {
  test('swaps a Chat URL for the Responses endpoint, and back', () => {
    expect(retargetOpenAIUrl(chat, 'responses')).toBe(responses)
    expect(retargetOpenAIUrl(responses, 'chat')).toBe(chat)
  })

  test('a URL already on the target comes back as it was', () => {
    expect(retargetOpenAIUrl(chat, 'chat')).toBe(chat)
    expect(retargetOpenAIUrl(responses, 'responses')).toBe(responses)
  })

  test('keeps a trailing slash', () => {
    expect(retargetOpenAIUrl(`${chat}/`, 'responses')).toBe(`${responses}/`)
    expect(retargetOpenAIUrl(`${responses}/`, 'chat')).toBe(`${chat}/`)
  })

  test('keeps a query string and a fragment', () => {
    expect(retargetOpenAIUrl(`${chat}?api-version=2025-04-01`, 'responses')).toBe(`${responses}?api-version=2025-04-01`)
    expect(retargetOpenAIUrl(`${responses}/?a=1&b=2#frag`, 'chat')).toBe(`${chat}/?a=1&b=2#frag`)
  })

  test('works for a proxy path and a vendor with a bare /chat/completions', () => {
    expect(retargetOpenAIUrl('https://proxy.example/openai/v1/chat/completions', 'responses')).toBe(
      'https://proxy.example/openai/v1/responses'
    )
    expect(retargetOpenAIUrl('https://api.deepseek.com/chat/completions', 'responses')).toBe(
      'https://api.deepseek.com/responses'
    )
  })

  test('a URL that names neither endpoint has nothing to swap', () => {
    expect(retargetOpenAIUrl('https://proxy.example/v1/foo', 'chat')).toBeNull()
    expect(retargetOpenAIUrl('https://proxy.example/v1/foo', 'responses')).toBeNull()
    // The Codex backend root: codex-oauth appends its own /responses.
    expect(retargetOpenAIUrl('https://chatgpt.com/backend-api/codex', 'responses')).toBeNull()
    // MiniMax's Chat endpoint is not spelled /chat/completions.
    expect(retargetOpenAIUrl('https://api.minimax.chat/v1/text/chatcompletion_v2', 'chat')).toBeNull()
  })

  test('only a tail at the end of the path counts', () => {
    // A directory that merely starts with the word, or sits mid-path.
    expect(retargetOpenAIUrl('https://proxy.example/v1/responses-proxy', 'chat')).toBeNull()
    expect(retargetOpenAIUrl('https://proxy.example/v1/responses/extra', 'chat')).toBeNull()
    expect(retargetOpenAIUrl('https://proxy.example/v1/chat/completionsx', 'responses')).toBeNull()
    // A query that mentions an endpoint does not make the path one.
    expect(retargetOpenAIUrl('https://proxy.example/v1?next=/responses', 'chat')).toBeNull()
  })

  test('takes the last tail when the path holds both', () => {
    expect(retargetOpenAIUrl('https://proxy.example/responses/chat/completions', 'responses')).toBe(
      'https://proxy.example/responses/responses'
    )
  })
})

describe('redirectedOpenAIUrl', () => {
  test('reports a URL only when the stored one has to change', () => {
    expect(redirectedOpenAIUrl(chat, 'responses')).toBe(responses)
    expect(redirectedOpenAIUrl(responses, 'chat')).toBe(chat)
  })

  test('is null when the stored URL is already right', () => {
    expect(redirectedOpenAIUrl(chat, 'chat')).toBeNull()
    expect(redirectedOpenAIUrl(responses, 'responses')).toBeNull()
  })

  test('is null when the stored URL names no endpoint', () => {
    expect(redirectedOpenAIUrl('https://chatgpt.com/backend-api/codex', 'responses')).toBeNull()
    expect(redirectedOpenAIUrl('https://proxy.example/v1/foo', 'chat')).toBeNull()
  })
})

/**
 * Regression: /v1/chat/completions and /v1/responses targeting
 * `claude-code,*` returned the raw Anthropic Messages envelope, so an
 * OpenAI SDK reading `res.choices[0].message.content` saw undefined.
 * This module converts Anthropic → chat.completion so the SDK sees the
 * shape it expects.
 */

import { describe, expect, test } from 'bun:test'
import { convertAnthropicResponseToChat, isAnthropicMessageResponse } from '../../src/llms/transformers/anthropic'

describe('isAnthropicMessageResponse', () => {
  test('accepts a canonical Anthropic message envelope', () => {
    expect(
      isAnthropicMessageResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    ).toBe(true)
  })

  test('rejects a chat.completion envelope (already converted)', () => {
    expect(
      isAnthropicMessageResponse({
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }]
      })
    ).toBe(false)
  })

  test('rejects non-object / null', () => {
    expect(isAnthropicMessageResponse(null)).toBe(false)
    expect(isAnthropicMessageResponse('string')).toBe(false)
    expect(isAnthropicMessageResponse(undefined)).toBe(false)
  })

  test('rejects a body without content array (partial / error shape)', () => {
    expect(isAnthropicMessageResponse({ type: 'message', content: 'not-array' })).toBe(false)
  })
})

describe('convertAnthropicResponseToChat', () => {
  test('single-text response becomes choices[0].message.content string', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_1',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1 }
    })
    expect(chat.id).toBe('msg_1')
    expect(chat.object).toBe('chat.completion')
    expect(chat.model).toBe('claude-haiku-4-5')
    const choices = chat.choices as Array<Record<string, unknown>>
    expect(choices).toHaveLength(1)
    expect(choices[0].index).toBe(0)
    expect(choices[0].finish_reason).toBe('stop')
    const message = choices[0].message as Record<string, unknown>
    expect(message.role).toBe('assistant')
    expect(message.content).toBe('pong')
    expect(chat.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 0 }
    })
  })

  test('multiple text blocks concatenate', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_x',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' }
      ]
    })
    const message = (chat.choices as Array<{ message: { content: string } }>)[0].message
    expect(message.content).toBe('hello world')
  })

  test('tool_use blocks become choices[0].message.tool_calls with JSON-stringified arguments', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_tool',
      content: [
        { type: 'text', text: 'let me look that up' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'tokyo' } }
      ],
      stop_reason: 'tool_use'
    })
    const message = (chat.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    expect(message.content).toBe('let me look that up')
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].id).toBe('toolu_1')
    expect(toolCalls[0].type).toBe('function')
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe('search')
    // arguments MUST be a JSON string, not the object — OpenAI SDK parses
    // it back into an object on the caller side.
    expect((toolCalls[0].function as Record<string, unknown>).arguments).toBe('{"q":"tokyo"}')
    expect((chat.choices as Array<Record<string, unknown>>)[0].finish_reason).toBe('tool_calls')
  })

  test('text-less tool_use-only response yields content: null (matches OpenAI convention)', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_only_tool',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'x', input: {} }],
      stop_reason: 'tool_use'
    })
    const message = (chat.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    expect(message.content).toBeNull()
    expect(Array.isArray(message.tool_calls)).toBe(true)
  })

  test('stop_reason mapping — end_turn/tool_use/max_tokens/stop_sequence', () => {
    const cases: Array<[string, string]> = [
      ['end_turn', 'stop'],
      ['tool_use', 'tool_calls'],
      ['max_tokens', 'length'],
      ['stop_sequence', 'stop']
    ]
    for (const [ant, oai] of cases) {
      const chat = convertAnthropicResponseToChat({
        id: 'x',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: ant
      })
      const choice = (chat.choices as Array<Record<string, unknown>>)[0]
      expect(choice.finish_reason).toBe(oai)
    }
  })

  // The cache read is restated as Chat's cached_tokens — "cached tokens
  // present in the prompt", so already inside prompt_tokens — the same
  // usage the streaming converter reports.
  test('usage folds cache_read + cache_creation into prompt_tokens, and names the read as cached', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_cache',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens: 4
      }
    })
    expect(chat.usage).toEqual({
      prompt_tokens: 10 + 100 + 20,
      completion_tokens: 4,
      total_tokens: 10 + 100 + 20 + 4,
      prompt_tokens_details: { cached_tokens: 100 }
    })
  })

  test('thinking blocks become message.thinking, signed by the last signature', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_think',
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'first', signature: 'sig_a' },
        { type: 'thinking', thinking: ' then', signature: 'sig_b' },
        { type: 'text', text: 'answer' }
      ],
      stop_reason: 'end_turn'
    })
    const message = Object(Object(chat.choices)[0]).message
    expect(message.thinking).toEqual({ content: 'first then', signature: 'sig_b' })
    expect(message.content).toBe('answer')
  })

  test('server tool blocks are not handed to the client as calls to run', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_search',
      type: 'message',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'text', text: 'found it' }
      ],
      stop_reason: 'end_turn'
    })
    const message = Object(Object(chat.choices)[0]).message
    expect(message.tool_calls).toBeUndefined()
    expect(message.content).toBe('found it')
  })

  test('a refusal is a content filter, and an exhausted context window a truncation', () => {
    const finish = (stopReason: string): unknown =>
      Object(Object(convertAnthropicResponseToChat({ id: 'x', content: [], stop_reason: stopReason }).choices)[0])
        .finish_reason
    expect(finish('refusal')).toBe('content_filter')
    expect(finish('model_context_window_exceeded')).toBe('length')
  })

  test('missing usage omits the field rather than stamping zeros', () => {
    const chat = convertAnthropicResponseToChat({
      id: 'msg_nou',
      content: [{ type: 'text', text: 'ok' }]
    })
    expect(chat.usage).toBeUndefined()
  })
})

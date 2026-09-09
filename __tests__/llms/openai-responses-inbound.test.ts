/**
 * Unit tests for the /v1/responses inbound converters — the reverse of
 * what request.ts / response-json.ts do on the outbound side. Small
 * pure-function surface, no DB and no upstream, so these can run in
 * isolation.
 */

import { describe, expect, test } from 'bun:test'
import {
  convertChatCompletionToResponses,
  convertResponsesRequestToUnified,
  wrapResponsesEnvelopeAsSse
} from '../../src/llms/transformers/openai/responses/inbound'

describe('convertResponsesRequestToUnified', () => {
  test('string input becomes a single user message', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'hello there'
    })
    expect(unified.model).toBe('gpt-5-mini')
    expect(unified.messages).toEqual([{ role: 'user', content: 'hello there' }])
    expect((unified as Record<string, unknown>).input).toBeUndefined()
  })

  test('instructions prepend a system message', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      instructions: 'You are terse.',
      input: 'ping'
    })
    expect(unified.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'ping' }
    ])
    expect((unified as Record<string, unknown>).instructions).toBeUndefined()
  })

  // Regression: left in place, `max_output_tokens` rode the `...body` spread
  // out to the vendor, which answered 400 "Unknown parameter". Every caller
  // that set an output ceiling hit it, so nothing streamed at all.
  test('max_output_tokens becomes the unified max_tokens', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'ping',
      max_output_tokens: 256
    })
    expect(unified.max_tokens).toBe(256)
    expect((unified as Record<string, unknown>).max_output_tokens).toBeUndefined()
  })

  test('an explicit max_tokens wins over max_output_tokens', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'ping',
      max_tokens: 64,
      max_output_tokens: 256
    })
    expect(unified.max_tokens).toBe(64)
    expect((unified as Record<string, unknown>).max_output_tokens).toBeUndefined()
  })

  test('no cap stays absent rather than becoming undefined-valued', () => {
    const unified = convertResponsesRequestToUnified({ model: 'gpt-5-mini', input: 'ping' })
    expect('max_tokens' in (unified as Record<string, unknown>)).toBe(false)
  })

  test('array input with input_text and output_text blocks flatten to plain text messages', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Say ' },
            { type: 'input_text', text: 'pong.' }
          ]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pong' }]
        }
      ]
    })
    expect(unified.messages).toEqual([
      { role: 'user', content: 'Say pong.' },
      { role: 'assistant', content: 'pong' }
    ])
  })

  test('function_call and function_call_output become tool_calls and tool role messages', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: [
        { type: 'message', role: 'user', content: 'weather?' },
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"tokyo"}'
        },
        { type: 'function_call_output', call_id: 'call_abc', output: '{"temp":30}' }
      ]
    })
    expect(unified.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"tokyo"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":30}' }
    ])
  })

  test('function_call_output serialises non-string output', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: [{ type: 'function_call_output', call_id: 'call_xyz', output: { ok: true, count: 3 } }]
    })
    expect(unified.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_xyz',
      content: '{"ok":true,"count":3}'
    })
  })

  test('input_image blocks become multimodal content on user messages', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is this?' },
            { type: 'input_image', image_url: 'https://example.com/cat.png' }
          ]
        }
      ]
    })
    expect(unified.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }
      ]
    })
  })

  test('tools convert from Responses flat shape to Chat nested shape', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'x',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } }
        }
      ]
    })
    expect(unified.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } }
        }
      }
    ])
  })

  test('Responses-only fields are stripped from the unified body', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'x',
      instructions: 'go',
      parallel_tool_calls: true,
      previous_response_id: 'resp_abc',
      store: false
    })
    const bag = unified as Record<string, unknown>
    expect(bag.input).toBeUndefined()
    expect(bag.instructions).toBeUndefined()
    expect(bag.parallel_tool_calls).toBeUndefined()
    expect(bag.previous_response_id).toBeUndefined()
    expect(bag.store).toBeUndefined()
  })

  test('absorbs an Anthropic-style top-level `system` (persona-leaked defence)', () => {
    // Persona injection sets `body.system` — the router now gates it on
    // Anthropic inbound only, but the endpoint transformer keeps the
    // absorption as belt-and-braces so any future injection can't slip
    // through as a stray top-level field.
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'hi',
      system: 'You are terse.'
    })
    expect(unified.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' }
    ])
    expect((unified as Record<string, unknown>).system).toBeUndefined()
  })

  test('system + instructions both prepend — instructions first, then system, then user', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5-mini',
      input: 'hi',
      instructions: 'Instr text',
      system: 'System text'
    })
    // instructions creates the first system message → system absorption
    // then sees an existing system[0] and skips prepending. Deterministic
    // ordering: instructions wins when both are present.
    expect(unified.messages[0]).toEqual({ role: 'system', content: 'Instr text' })
    expect((unified as Record<string, unknown>).system).toBeUndefined()
  })

  test('reasoning.effort survives round-trip into unified', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.6-luna',
      input: 'x',
      reasoning: { effort: 'high' }
    })
    expect((unified as Record<string, unknown>).reasoning).toEqual({ effort: 'high' })
  })
})

describe('convertChatCompletionToResponses', () => {
  test('text-only chat.completion becomes a single message output item', () => {
    const envelope = convertChatCompletionToResponses({
      id: 'chatcmpl-xyz',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-5-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
    })
    expect(envelope.object).toBe('response')
    expect(envelope.status).toBe('completed')
    expect(envelope.model).toBe('gpt-5-mini')
    expect(envelope.created_at).toBe(1_700_000_000)
    expect(envelope.usage).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    const output = envelope.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('message')
    expect(output[0].role).toBe('assistant')
    expect(output[0].content).toEqual([{ type: 'output_text', text: 'Hello!', annotations: [] }])
  })

  test('tool_calls become function_call output items with the caller id preserved', () => {
    const envelope = convertChatCompletionToResponses({
      id: 'chatcmpl-tool',
      model: 'gpt-5-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"foo"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })
    const output = envelope.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('function_call')
    expect(output[0].call_id).toBe('call_1')
    expect(output[0].name).toBe('search')
    expect(output[0].arguments).toBe('{"q":"foo"}')
  })

  test('missing usage omits the field rather than emitting zeros', () => {
    const envelope = convertChatCompletionToResponses({
      id: 'chatcmpl-no-usage',
      model: 'gpt-5-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }]
    })
    expect(envelope.usage).toBeUndefined()
  })
})

describe('wrapResponsesEnvelopeAsSse', () => {
  test('emits response.created, response.output_text.delta with full text, then response.completed', () => {
    const envelope = {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5-mini',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'pong', annotations: [] }]
        }
      ]
    }
    const sse = wrapResponsesEnvelopeAsSse(envelope)
    // Events are separated by blank lines. Extract type field from every
    // parseable data payload so we can assert the sequence.
    const events = sse
      .split(/\n\n/)
      .filter((chunk) => chunk.trim().length > 0)
      .map((chunk) => {
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '))
        if (!dataLine) return null
        return JSON.parse(dataLine.slice(6)) as Record<string, unknown>
      })
      .filter((v): v is Record<string, unknown> => v !== null)
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('response.created')
    expect(types[1]).toBe('response.in_progress')
    expect(types).toContain('response.output_item.added')
    expect(types).toContain('response.output_text.delta')
    expect(types).toContain('response.output_text.done')
    expect(types).toContain('response.output_item.done')
    expect(types[types.length - 1]).toBe('response.completed')
    const delta = events.find((e) => e.type === 'response.output_text.delta')
    expect(delta?.delta).toBe('pong')
    const completed = events.find((e) => e.type === 'response.completed')
    expect((completed?.response as { id?: string })?.id).toBe('resp_1')
  })

  test('function_call output items emit function_call_arguments delta and done', () => {
    const envelope = {
      id: 'resp_tool',
      object: 'response',
      status: 'completed',
      model: 'gpt-5-mini',
      output: [
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"x"}'
        }
      ]
    }
    const sse = wrapResponsesEnvelopeAsSse(envelope)
    expect(sse).toContain('response.function_call_arguments.delta')
    expect(sse).toContain('response.function_call_arguments.done')
    expect(sse).toContain('"delta":"{\\"q\\":\\"x\\"}"')
  })
})

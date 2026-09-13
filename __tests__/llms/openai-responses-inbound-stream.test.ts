/**
 * The incremental chat-SSE → Responses-SSE converter.
 *
 * `__tests__/parity/streaming.test.ts` owns the parity claim (the
 * upstream's granularity survives). This file covers what that row does
 * not reach: the two tool-call kinds, the item ordering, and the two
 * degenerate streams — no events at all, and a stream cut off mid-call.
 */

import { describe, expect, test } from 'bun:test'
import { convertChatSseToResponsesSse } from '../../src/llms/transformers/openai/responses/inbound-stream'

const chunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

const upstream = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const convert = async (body: string): Promise<Record<string, unknown>[]> => {
  const converted = convertChatSseToResponsesSse(upstream(body))
  if (converted === null) throw new Error('expected a converted response')
  const raw = await converted.text()
  const out: Record<string, unknown>[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    const parsed: unknown = JSON.parse(payload)
    if (parsed !== null && typeof parsed === 'object') out.push(Object(parsed))
  }
  return out
}

const types = (events: Record<string, unknown>[]): string[] =>
  events.map((e) => (typeof e.type === 'string' ? e.type : ''))

const completedOutput = (events: Record<string, unknown>[]): Record<string, unknown>[] => {
  const completed = events.find((e) => e.type === 'response.completed')
  const output = Reflect.get(Object(completed?.response), 'output')
  return Array.isArray(output) ? output.map((item) => Object(item)) : []
}

describe('text', () => {
  test('each upstream content delta becomes one output_text.delta', async () => {
    const events = await convert(
      chunk({ id: 'chatcmpl-1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'a' } }] }) +
        chunk({ choices: [{ index: 0, delta: { content: 'b' } }] }) +
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n'
    )
    expect(events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta)).toEqual(['a', 'b'])
    const done = events.find((e) => e.type === 'response.output_text.done')
    expect(done?.text).toBe('ab')
  })

  test('the opening pair carries the upstream id and stays in_progress', async () => {
    const events = await convert(
      chunk({ id: 'chatcmpl-1', created: 42, model: 'gpt-x', choices: [{ index: 0, delta: { content: 'a' } }] })
    )
    const created = Object(events[0].response)
    expect(events[0].type).toBe('response.created')
    expect(Reflect.get(created, 'id')).toBe('chatcmpl-1')
    expect(Reflect.get(created, 'created_at')).toBe(42)
    expect(Reflect.get(created, 'model')).toBe('gpt-x')
    expect(Reflect.get(created, 'status')).toBe('in_progress')
    expect(Reflect.get(created, 'output')).toEqual([])
  })

  test('usage from the final chunk is renamed onto the completed envelope', async () => {
    const events = await convert(
      chunk({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'a' } }] }) +
        chunk({ id: 'c', model: 'm', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
    )
    const completed = events.find((e) => e.type === 'response.completed')
    expect(Reflect.get(Object(completed?.response), 'usage')).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10
    })
  })
})

describe('tool calls', () => {
  const FUNCTION_STREAM =
    chunk({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'thinking' } }] }) +
    chunk({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ls' } }] } }
      ]
    }) +
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"p"' } }] } }] }) +
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"/"}' } }] } }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })

  test('argument fragments arrive as they come, not as one blob', async () => {
    const events = await convert(FUNCTION_STREAM)
    expect(events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta)).toEqual([
      '{"p"',
      ':"/"}'
    ])
    const done = events.find((e) => e.type === 'response.function_call_arguments.done')
    expect(done?.arguments).toBe('{"p":"/"}')
  })

  test('the prose item closes before the call item opens', async () => {
    const names = types(await convert(FUNCTION_STREAM))
    const textDone = names.indexOf('response.output_text.done')
    const callAdded = names.lastIndexOf('response.output_item.added')
    expect(textDone).toBeGreaterThan(-1)
    expect(textDone).toBeLessThan(callAdded)
  })

  test('the completed envelope holds both items in order', async () => {
    const output = completedOutput(await convert(FUNCTION_STREAM))
    expect(output.map((item) => item.type)).toEqual(['message', 'function_call'])
    expect(output[1].call_id).toBe('call_1')
    expect(output[1].name).toBe('ls')
    expect(output[1].arguments).toBe('{"p":"/"}')
    expect(output[1].status).toBe('completed')
  })

  test('a custom tool call gets its own events, never the function pair', async () => {
    const events = await convert(
      chunk({
        id: 'c',
        model: 'm',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'custom', function: { name: 'shell' } }] } }
        ]
      }) + chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'echo hi' } }] } }] })
    )
    const names = types(events)
    expect(names).toContain('response.custom_tool_call_input.delta')
    expect(names).toContain('response.custom_tool_call_input.done')
    expect(names).not.toContain('response.function_call_arguments.delta')
    const done = events.find((e) => e.type === 'response.custom_tool_call_input.done')
    expect(done?.input).toBe('echo hi')
    const output = completedOutput(events)
    expect(output[0].type).toBe('custom_tool_call')
    expect(output[0].input).toBe('echo hi')
  })

  test('two parallel calls keep their own items, keyed on the upstream index', async () => {
    const events = await convert(
      chunk({
        id: 'c',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } }
              ]
            }
          }
        ]
      })
    )
    const output = completedOutput(events)
    expect(output.map((item) => item.call_id)).toEqual(['call_a', 'call_b'])
  })
})

describe('degenerate streams', () => {
  test('a stream with nothing parseable emits nothing rather than a fabricated success', async () => {
    expect(await convert('data: [DONE]\n\n')).toEqual([])
    expect(await convert('')).toEqual([])
  })

  test('a stream cut off mid-call still closes every item it opened', async () => {
    const names = types(
      await convert(
        chunk({
          id: 'c',
          model: 'm',
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ls' } }] }
            }
          ]
        })
      )
    )
    expect(names).toContain('response.function_call_arguments.done')
    expect(names).toContain('response.output_item.done')
    expect(names[names.length - 1]).toBe('response.completed')
  })

  test('a malformed event is dropped, not fatal', async () => {
    const events = await convert(
      chunk({ id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'a' } }] }) +
        'data: {not json\n\n' +
        chunk({ choices: [{ index: 0, delta: { content: 'b' } }] })
    )
    expect(events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta)).toEqual(['a', 'b'])
  })

  test('a response with no body falls back rather than throwing', () => {
    expect(convertChatSseToResponsesSse(new Response(null, { status: 200 }))).toBeNull()
  })
})

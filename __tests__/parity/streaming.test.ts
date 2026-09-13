/**
 * Parity matrix — the "streaming (SSE)" row.
 *
 * Whether each surface can return SSE in its own vocabulary. What is
 * judged is the **conversion path** (the surface's wire format differs
 * from the provider's), which the surface's endpoint transformer handles
 * in `transformResponseIn`. A request bound for a provider that speaks
 * the same wire format takes the pipeline's bypass and runs no conversion
 * at all, so it is out of scope here — see "judging criteria" in
 * docs/architecture/inbound-parity.md.
 *
 * The internal representation is OpenAI chat.completion, so the input on
 * all four is chat.completion.chunk SSE. What differs is the output
 * vocabulary; all four now relay the upstream's granularity rather than
 * folding the stream and re-emitting it whole.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { TransformerContext } from '../../src/schemas/domain'

const ctx = { req: { id: 'parity' } } as unknown as TransformerContext

const chunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

const chatStream = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

// Two separate content deltas, so a converter that buffers is
// distinguishable from one that relays the upstream cadence.
const TWO_DELTA_STREAM =
  chunk({
    id: 'chatcmpl-parity',
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }]
  }) +
  chunk({ id: 'chatcmpl-parity', model: 'm', choices: [{ index: 0, delta: { content: 'lo' } }] }) +
  chunk({ id: 'chatcmpl-parity', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
  'data: [DONE]\n\n'

const eventNames = (raw: string): string[] =>
  raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith('event:'))
    .map((l) => l.slice(6).trim())

const dataPayloads = (raw: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const body = line.slice(5).trim()
    if (body.length === 0 || body === '[DONE]') continue
    const parsed: unknown = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
  }
  return out
}

describe('anthropic-messages — supported, incrementally', () => {
  test("chat.completion.chunk SSE becomes Anthropic's event vocabulary", async () => {
    const converted = await new AnthropicTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    expect(converted.headers.get('Content-Type')).toBe('text/event-stream')
    const raw = await converted.text()
    const names = eventNames(raw)
    expect(names).toContain('message_start')
    expect(names).toContain('content_block_delta')
    expect(names).toContain('message_stop')
  })

  test('the upstream granularity carries through: two deltas become two events', async () => {
    const converted = await new AnthropicTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    const texts = dataPayloads(await converted.text())
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => {
        const delta = e.delta
        return delta !== null && typeof delta === 'object' ? Reflect.get(delta, 'text') : undefined
      })
    expect(texts).toEqual(['Hel', 'lo'])
  })
})

describe('openai-chat — supported by passing through', () => {
  // The internal representation is chat.completion itself, so this
  // surface needs no conversion. Inheriting the base's identity
  // `transformResponseIn` is what "supported" means here: the upstream
  // bytes reach the client unchanged.
  test('the endpoint transformer does not touch the response', async () => {
    const upstream = chatStream(TWO_DELTA_STREAM)
    const relayed = await new OpenAITransformer().transformResponseIn(upstream, ctx)
    expect(relayed).toBe(upstream)
    expect(await relayed.text()).toBe(TWO_DELTA_STREAM)
  })
})

describe('openai-responses — supported, incrementally', () => {
  test('converted into the Responses event vocabulary', async () => {
    const converted = await new OpenAIResponsesTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    expect(converted.headers.get('content-type')).toBe('text/event-stream')
    const names = eventNames(await converted.text())
    expect(names[0]).toBe('response.created')
    expect(names).toContain('response.output_text.delta')
    expect(names[names.length - 1]).toBe('response.completed')
  })

  test('the upstream granularity carries through: two deltas become two events', async () => {
    const converted = await new OpenAIResponsesTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    const deltas = dataPayloads(await converted.text())
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
    expect(deltas).toEqual(['Hel', 'lo'])
  })

  test('the completed envelope still carries the whole text, for a client that ignores the deltas', async () => {
    const converted = await new OpenAIResponsesTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    const events = dataPayloads(await converted.text())
    const completed = events.find((e) => e.type === 'response.completed')
    const response = Object(completed?.response)
    const output = Reflect.get(response, 'output')
    const first = Array.isArray(output) ? Object(output[0]) : {}
    const content = Reflect.get(first, 'content')
    const block = Array.isArray(content) ? Object(content[0]) : {}
    expect(Reflect.get(block, 'text')).toBe('Hello')
    expect(Reflect.get(response, 'status')).toBe('completed')
  })

  // The point of the conversion being incremental: bytes must reach the
  // client while the upstream is still generating. A buffered converter
  // passes every expectation above and still fails this one — and it is
  // the failure a reverse proxy turns into a 524 on a long answer.
  test('the first event is readable before the upstream stream has ended', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(
          encoder.encode(chunk({ id: 'chatcmpl-ttft', model: 'm', choices: [{ index: 0, delta: { content: 'Hel' } }] }))
        )
        // Deliberately left open: no close(), no further chunks.
      }
    })
    const converted = await new OpenAIResponsesTransformer().transformResponseIn(
      new Response(upstream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      ctx
    )
    const body = converted.body
    if (body === null) throw new Error('the converted response carries no body')
    const reader = body.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('response.created')
    await reader.cancel()
  })
})

describe('gemini-generate — supported, incrementally', () => {
  test('chat.completion.chunk SSE becomes the candidates[] vocabulary', async () => {
    const converted = await new GeminiTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    expect(converted.headers.get('Content-Type')).toBe('text/event-stream')
    const events = dataPayloads(await converted.text())
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].candidates).toBeDefined()
  })

  test('the upstream granularity carries through: two deltas become two chunks', async () => {
    const converted = await new GeminiTransformer().transformResponseIn(chatStream(TWO_DELTA_STREAM), ctx)
    const texts = dataPayloads(await converted.text()).flatMap((e) => {
      const candidates = Array.isArray(e.candidates) ? e.candidates : []
      return candidates.flatMap((c: unknown) => {
        const content = c !== null && typeof c === 'object' ? Reflect.get(c, 'content') : undefined
        const parts = content !== null && typeof content === 'object' ? Reflect.get(content, 'parts') : undefined
        return Array.isArray(parts) ? parts.map((p: unknown) => Reflect.get(Object(p), 'text')) : []
      })
    })
    expect(texts).toEqual(['Hel', 'lo'])
  })
})

/**
 * Parity matrix — the "non-streaming aggregation" row.
 *
 * When a request arrives with `stream: false` but the upstream speaks
 * only SSE — codex-oauth being the standing example — the surface
 * descriptor's `aggregateSse` folds the events back into a non-streaming
 * envelope in that surface's own vocabulary. All four have a dedicated
 * aggregator.
 *
 * The folding rules for openai-chat, openai-responses and gemini are
 * covered by `__tests__/llms/sse-aggregate.test.ts`, so what is pinned
 * across surfaces here is only that **calling through the descriptor
 * returns each surface's envelope**. The Anthropic aggregator had no
 * unit test anywhere, so its block-level folding is covered here.
 */

import { describe, expect, test } from 'bun:test'
import { INBOUND_SURFACES, surfaceForPath } from '../../src/llms/inbound/surfaces'

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const event = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

// Per surface: the smallest stream written in that surface's own
// vocabulary, plus a fingerprint showing the fold produced that
// surface's envelope.
const CASES: ReadonlyArray<{
  path: string
  stream: string
  expect: (folded: Record<string, unknown>) => void
}> = [
  {
    path: '/v1/messages',
    stream:
      event({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 3 } } }) +
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }) +
      event({ type: 'content_block_stop', index: 0 }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
      event({ type: 'message_stop' }),
    expect: (folded) => {
      expect(folded.id).toBe('msg_1')
      expect(folded.content).toEqual([{ type: 'text', text: 'pong' }])
      expect(folded.stop_reason).toBe('end_turn')
      expect(folded.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
    }
  },
  {
    path: '/v1/chat/completions',
    stream:
      event({ id: 'chatcmpl-1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'po' } }] }) +
      event({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'ng' }, finish_reason: 'stop' }] }),
    expect: (folded) => {
      expect(folded.object).toBe('chat.completion')
      const choices = folded.choices as Array<Record<string, unknown>>
      expect(Reflect.get(Object(choices[0].message), 'content')).toBe('pong')
    }
  },
  {
    path: '/v1/responses',
    stream:
      event({ type: 'response.created', response: { id: 'resp_1', object: 'response', status: 'in_progress' } }) +
      event({ type: 'response.output_text.delta', output_index: 0, delta: 'pong' }) +
      event({
        type: 'response.completed',
        response: { id: 'resp_1', object: 'response', status: 'completed', output: [] }
      }),
    expect: (folded) => {
      expect(folded.object).toBe('response')
      expect(folded.status).toBe('completed')
      expect(folded.id).toBe('resp_1')
    }
  },
  {
    path: '/v1beta/models/gemini-3-pro:streamGenerateContent',
    stream:
      event({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'po' }] } }] }) +
      event({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ng' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
      }),
    expect: (folded) => {
      const candidates = folded.candidates as Array<Record<string, unknown>>
      expect(Reflect.get(Object(candidates[0].content), 'parts')).toEqual([{ text: 'pong' }])
      expect(folded.usageMetadata).toBeDefined()
    }
  }
]

describe('every surface folds into its own envelope', () => {
  test('the descriptors cover every surface, so the case table misses none', () => {
    expect(CASES.map((c) => surfaceForPath(c.path)?.id).sort()).toEqual(
      INBOUND_SURFACES.filter((s) => s.operation === 'completion')
        .map((s) => s.id)
        .slice()
        .sort()
    )
  })

  for (const testCase of CASES) {
    test(`${testCase.path} — the descriptor's aggregateSse returns that surface's envelope`, async () => {
      const surface = surfaceForPath(testCase.path)
      expect(surface).toBeDefined()
      testCase.expect(await surface!.aggregateSse(sse(testCase.stream)))
    })
  }
})

describe('anthropic-messages — block-level folding', () => {
  // Anthropic alone is structured as indexed blocks that open, receive
  // deltas and close, so naive concatenation cannot rebuild it. That is
  // what separates it from the other three, and it is also the one
  // aggregator that had no unit test.
  const fold = async (body: string): Promise<Record<string, unknown>> =>
    await surfaceForPath('/v1/messages')!.aggregateSse(sse(body))

  test('tool_use partial_json fragments become one JSON document on close', async () => {
    const folded = await fold(
      event({ type: 'message_start', message: { id: 'msg_t', role: 'assistant' } }) +
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'Read' }
        }) +
        event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } }) +
        event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'th":"a"}' }
        }) +
        event({ type: 'content_block_stop', index: 0 })
    )
    expect(folded.content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } }])
  })

  test('thinking deltas and the signature collect into the same block', async () => {
    const folded = await fold(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
        event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weigh' } }) +
        event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ing' } }) +
        event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }) +
        event({ type: 'content_block_stop', index: 0 })
    )
    expect(folded.content).toEqual([{ type: 'thinking', thinking: 'weighing', signature: 'sig' }])
  })

  test('multiple blocks come out in index order, not arrival order', async () => {
    const folded = await fold(
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'second' } }) +
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'first' } }) +
        event({ type: 'content_block_stop', index: 0 }) +
        event({ type: 'content_block_stop', index: 1 })
    )
    expect(folded.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ])
  })

  test('an upstream that cuts off mid-block still yields the unclosed content', async () => {
    const folded = await fold(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })
    )
    expect(folded.content).toEqual([{ type: 'text', text: 'partial' }])
  })
})

/**
 * Unit tests for the SSE→JSON aggregators. These fire in the
 * `formatResponse` branch that trips when the client asked for
 * stream=false but the upstream forced SSE (codex-oauth is the
 * canonical case). One aggregator per inbound wire shape.
 */

import { describe, expect, test } from 'bun:test'
import {
  aggregateAnthropicSseToJson,
  aggregateGeminiSseToJson,
  aggregateOpenAiChatSseToJson,
  aggregateOpenAiResponsesSseToJson,
  findSseStreamDefect
} from '../../src/llms/utils/sse-aggregate'

const sseResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const buildChatChunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

describe('aggregateOpenAiChatSseToJson', () => {
  test('folds text-delta chunks into a single choice with joined content', async () => {
    const body =
      buildChatChunk({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'gpt-4.1-mini',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }]
      }) +
      buildChatChunk({
        id: 'chatcmpl-1',
        choices: [{ index: 0, delta: { content: 'lo' } }]
      }) +
      buildChatChunk({
        id: 'chatcmpl-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      }) +
      'data: [DONE]\n\n'
    const result = await aggregateOpenAiChatSseToJson(sseResponse(body))
    expect(result.id).toBe('chatcmpl-1')
    expect(result.object).toBe('chat.completion')
    expect(result.model).toBe('gpt-4.1-mini')
    const choices = result.choices as Array<Record<string, unknown>>
    expect(choices).toHaveLength(1)
    expect(choices[0].finish_reason).toBe('stop')
    const message = choices[0].message as Record<string, unknown>
    expect(message.role).toBe('assistant')
    expect(message.content).toBe('Hello')
  })

  test('joins tool_call arguments across per-index chunks', async () => {
    const body =
      buildChatChunk({
        id: 'chatcmpl-tc',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":' }
                }
              ]
            }
          }
        ]
      }) +
      buildChatChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"tokyo"}' } }] }
          }
        ]
      }) +
      buildChatChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      })
    const result = await aggregateOpenAiChatSseToJson(sseResponse(body))
    const message = (result.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].id).toBe('call_1')
    expect(toolCalls[0].type).toBe('function')
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe('search')
    expect((toolCalls[0].function as Record<string, unknown>).arguments).toBe('{"q":"tokyo"}')
  })

  test('preserves usage when the terminal chunk carries it', async () => {
    const body = buildChatChunk({
      id: 'chatcmpl-usage',
      model: 'gpt-4.1-mini',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
    })
    const result = await aggregateOpenAiChatSseToJson(sseResponse(body))
    expect(result.usage).toEqual({ prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 })
  })
})

describe('aggregateOpenAiResponsesSseToJson', () => {
  test('returns the response payload from response.completed verbatim', async () => {
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_ok',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.6-luna',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'pong', annotations: [] }]
          }
        ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
      }
    }
    const body =
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_ok', object: 'response' } })}\n\n` +
      `data: ${JSON.stringify(completed)}\n\n`
    const result = await aggregateOpenAiResponsesSseToJson(sseResponse(body))
    expect(result).toEqual(completed.response)
  })

  test('falls back to text accumulator when response.completed never lands', async () => {
    const body =
      `data: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_cut', object: 'response', model: 'gpt-5.6-luna', output: [] }
      })}\n\n` +
      `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        output_index: 0,
        delta: 'part-1 '
      })}\n\n` +
      `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        output_index: 0,
        delta: 'part-2'
      })}\n\n`
    const result = await aggregateOpenAiResponsesSseToJson(sseResponse(body))
    expect(result.status).toBe('incomplete')
    const output = result.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    const content = output[0].content as Array<Record<string, unknown>>
    expect(content[0].text).toBe('part-1 part-2')
  })

  test('empty stream returns a skeleton envelope rather than throwing', async () => {
    const result = await aggregateOpenAiResponsesSseToJson(sseResponse(''))
    expect(result.object).toBe('response')
    expect(result.status).toBe('incomplete')
    expect(result.output).toEqual([])
  })
})

// ─── Gemini ────────────────────────────────────────────────────────────

const buildGeminiChunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

type GeminiCandidate = {
  index?: number
  finishReason?: string
  content?: { role?: string; parts?: Array<Record<string, unknown>> }
}

const candidatesOf = (result: Record<string, unknown>): GeminiCandidate[] => result.candidates as GeminiCandidate[]

describe('aggregateGeminiSseToJson', () => {
  test('joins the text parts of one candidate into a single part', async () => {
    const body =
      buildGeminiChunk({
        candidates: [{ content: { parts: [{ text: 'Hel' }], role: 'model' }, index: 0 }],
        modelVersion: 'gemini-3-pro'
      }) +
      buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'lo' }], role: 'model' }, index: 0 }] }) +
      buildGeminiChunk({
        candidates: [{ content: { parts: [{ text: '!' }], role: 'model' }, index: 0, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 }
      })
    const result = await aggregateGeminiSseToJson(sseResponse(body))
    const candidates = candidatesOf(result)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content?.parts).toEqual([{ text: 'Hello!' }])
    expect(candidates[0].content?.role).toBe('model')
    expect(candidates[0].finishReason).toBe('STOP')
    expect(result.usageMetadata).toEqual({ promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 })
    expect(result.modelVersion).toBe('gemini-3-pro')
  })

  test('reasoning text is not merged into the answer', async () => {
    // Gemini streams `thought: true` parts alongside answer parts on the
    // same candidate. Concatenating both into one part would hand the
    // caller a response whose visible text opens with the model's
    // private reasoning.
    const body =
      buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'weighing ', thought: true }] }, index: 0 }] }) +
      buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'options' }], role: 'model' }, index: 0 }] })
    const result = await aggregateGeminiSseToJson(sseResponse(body))
    expect(candidatesOf(result)[0].content?.parts).toEqual([{ text: 'weighing ', thought: true }, { text: 'options' }])
  })

  test('a functionCall part closes the open text run and survives verbatim', async () => {
    const body =
      buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'checking' }] }, index: 0 }] }) +
      buildGeminiChunk({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'tokyo' } } }], role: 'model' },
            index: 0,
            finishReason: 'STOP'
          }
        ]
      })
    const result = await aggregateGeminiSseToJson(sseResponse(body))
    expect(candidatesOf(result)[0].content?.parts).toEqual([
      { text: 'checking' },
      { functionCall: { name: 'get_weather', args: { city: 'tokyo' } } }
    ])
  })

  test('multiple candidates stay separate and come back in index order', async () => {
    const body =
      buildGeminiChunk({
        candidates: [
          { content: { parts: [{ text: 'b' }] }, index: 1 },
          { content: { parts: [{ text: 'a' }] }, index: 0 }
        ]
      }) + buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'a2' }] }, index: 0 }] })
    const candidates = candidatesOf(await aggregateGeminiSseToJson(sseResponse(body)))
    expect(candidates.map((c) => c.index)).toEqual([0, 1])
    expect(candidates[0].content?.parts).toEqual([{ text: 'aa2' }])
    expect(candidates[1].content?.parts).toEqual([{ text: 'b' }])
  })

  test('a truncated stream still yields the text that did arrive', async () => {
    // No finishReason, no usageMetadata — the client gets a coherent
    // envelope rather than a parse error on the raw SSE bytes.
    const body = buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'partial' }] }, index: 0 }] })
    const result = await aggregateGeminiSseToJson(sseResponse(body))
    expect(candidatesOf(result)[0].content?.parts).toEqual([{ text: 'partial' }])
    expect(result.usageMetadata).toBeUndefined()
  })

  test('malformed events are dropped rather than throwing', async () => {
    const body =
      'data: {not json\n\n' + buildGeminiChunk({ candidates: [{ content: { parts: [{ text: 'ok' }] }, index: 0 }] })
    const result = await aggregateGeminiSseToJson(sseResponse(body))
    expect(candidatesOf(result)[0].content?.parts).toEqual([{ text: 'ok' }])
  })

  test('an empty stream yields an empty candidate list, not a crash', async () => {
    const result = await aggregateGeminiSseToJson(sseResponse(''))
    expect(result.candidates).toEqual([])
  })
})

/**
 * The guard in front of the fold.
 *
 * The aggregators above are forgiving by design, and a truncated stream
 * should stay forgiven. What must NOT be forgiven is a stream that
 * carried nothing to fold, or one that ended in an upstream error:
 * those used to reach the caller as a 200 whose body no SDK could
 * parse — Claude Code reports it as "API returned an empty or malformed
 * response (HTTP 200)" and cannot retry, because a 200 is a success.
 */
describe('findSseStreamDefect', () => {
  const ev = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`

  test('an empty stream is a defect, and folding it alone would have produced a husk', async () => {
    expect(findSseStreamDefect('')).toEqual({ reason: 'no-events' })
    // The husk that used to be served with the upstream's 200: JSON,
    // but not a Message.
    const husk = await aggregateAnthropicSseToJson(sseResponse(''))
    expect(husk).toEqual({ content: [] })
    expect(husk.type).toBeUndefined()
  })

  test('a body of nothing but malformed events counts as no events', () => {
    expect(findSseStreamDefect('data: {not json\n\ndata: also not json\n\n')).toEqual({ reason: 'no-events' })
  })

  test("anthropic's overloaded_error becomes a 529 so the client backs off rather than giving up", () => {
    const body =
      ev({ type: 'ping' }) + ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    expect(findSseStreamDefect(body)).toEqual({
      reason: 'upstream-error',
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
    })
  })

  test('a mid-stream rate_limit_error keeps its 429', () => {
    const body = ev({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
    expect(findSseStreamDefect(body)?.status).toBe(429)
  })

  test("google's error.code is an HTTP status and is used verbatim", () => {
    const body = ev({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } })
    expect(findSseStreamDefect(body)?.status).toBe(503)
  })

  test('an error event that classifies neither way falls back to 502', () => {
    const body = ev({ error: { message: 'upstream exploded' } })
    expect(findSseStreamDefect(body)).toEqual({
      reason: 'upstream-error',
      status: 502,
      body: { error: { message: 'upstream exploded' } }
    })
  })

  test('an error event anywhere in the stream is found, not just the last one', () => {
    const body =
      ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant' } }) +
      ev({ type: 'error', error: { type: 'api_error', message: 'died mid-flight' } })
    expect(findSseStreamDefect(body)?.reason).toBe('upstream-error')
  })

  test('healthy streams in all three vocabularies are not defects', () => {
    const anthropic =
      ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant' } }) +
      ev({ type: 'message_stop' })
    const openai = ev({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'hi' } }] }) + 'data: [DONE]\n\n'
    const gemini = ev({ candidates: [{ content: { parts: [{ text: 'hi' }] }, index: 0 }] })
    expect(findSseStreamDefect(anthropic)).toBeNull()
    expect(findSseStreamDefect(openai)).toBeNull()
    expect(findSseStreamDefect(gemini)).toBeNull()
  })

  test('a merely truncated stream stays forgiven — the fold still has something to say', async () => {
    // This is the line between the two behaviours: message_start landed,
    // so the client gets a real Message with empty content rather than
    // an error. Only "nothing usable at all" is a defect.
    const body = ev({
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 3 } }
    })
    expect(findSseStreamDefect(body)).toBeNull()
    expect((await aggregateAnthropicSseToJson(sseResponse(body))).type).toBe('message')
  })
})

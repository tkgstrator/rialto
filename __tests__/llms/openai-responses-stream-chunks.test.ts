/**
 * Regression tests for the Responses→Chat stream converter.
 *
 * Reporter caught a case where /v1/chat/completions occasionally
 * returned `choices` with an empty [0] and the real content in [1]:
 *
 *   choices=[{index:0, content:'',    finish_reason:'stop'},
 *            {index:1, content:'391', finish_reason:null}]
 *
 * Root cause: `bumpIndex` incremented on every distinct upstream event
 * type, so text_delta chunks emitted at index=N while
 * buildCompletedChunk hardcoded index=0. OpenAI SDKs read
 * choices[0].message.content and reported empty. The same misalignment
 * left `/v1/responses` returning `output:[]`.
 *
 * The fix pins choices[].index to 0 for all chat.completion.chunk
 * events. These tests aggregate a realistic codex-style event sequence
 * (reasoning items first, then message text, then completed) through
 * the aggregator and assert the shape the SDK sees.
 *
 * Also covers the usage-passthrough on the completed chunk (reporter's
 * #3 — usage was always null on the non-stream aggregate).
 */

import { describe, expect, test } from 'bun:test'
import { convertChatCompletionToResponses } from '../../src/llms/transformers/openai/responses/inbound'
import { handleStreamEvent, ResponsesStreamCursor } from '../../src/llms/transformers/openai/responses/stream-chunks'
import { aggregateOpenAiChatSseToJson } from '../../src/llms/utils/sse-aggregate'

function driveStream(events: unknown[]): Response {
  const chunks: string[] = []
  const bumpIndex = (): number => 0
  // Simulate what ResponsesStreamSession does around handleStreamEvent
  // — the real getCurrentIndex now always returns 0, mirrored here.
  const enqueue = (chunk: unknown): void => {
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  const cursor = new ResponsesStreamCursor()
  for (const ev of events) {
    handleStreamEvent(ev as never, bumpIndex, enqueue, cursor)
  }
  chunks.push('data: [DONE]\n\n')
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

describe('Responses→Chat stream converter — choices index alignment', () => {
  test('a codex-style stream with reasoning items ahead of the message aggregates to a single choice[0]', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'r1', type: 'reasoning', content: [], reasoning: '' }
      },
      // reasoning delta events aren't in the switch handlers we care about
      // for choice-index; they wouldn't reach message content.
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 1, delta: 'pong' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }
        }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    const choices = aggregate.choices as Array<Record<string, unknown>>
    // The SDK reads choices[0] — assert we produced exactly one choice
    // and that it carries the content + finish_reason together.
    expect(choices).toHaveLength(1)
    expect(choices[0].index).toBe(0)
    const message = choices[0].message as Record<string, unknown>
    expect(message.content).toBe('pong')
    expect(choices[0].finish_reason).toBe('stop')
  })

  test('usage survives the ResponsesStreamEvent schema (previously stripped, causing usage: null)', async () => {
    // Regression: the response object schema originally only allowed
    // {id, model, output} so Zod stripped `usage` before
    // buildCompletedChunk could read it. Reporter hit v2.60.2 with
    // usage: null even after the completed-chunk builder added the
    // field.
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_check',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          // Real codex payload — includes extra fields Zod must not
          // reject and usage sub-fields it must preserve.
          usage: {
            input_tokens: 18,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 23
          }
        }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    expect(aggregate.usage).toEqual({
      prompt_tokens: 18,
      completion_tokens: 5,
      total_tokens: 23,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 }
    })
  })

  test('usage from response.completed makes it into the aggregate envelope', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_u',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }
        }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    expect(aggregate.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
  })

  test('reasoning and cached counts survive the Responses -> Chat rename', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_d',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          usage: {
            input_tokens: 1200,
            input_tokens_details: { cached_tokens: 1024 },
            output_tokens: 900,
            // The number that matters for effort tuning: most of the
            // output on a high-effort run is reasoning, not text.
            output_tokens_details: { reasoning_tokens: 832, audio_tokens: 0 },
            total_tokens: 2100
          }
        }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    expect(aggregate.usage?.prompt_tokens_details).toEqual({ cached_tokens: 1024 })
    // Unknown sub-fields ride along rather than being filtered to a
    // known list, so new counters need no change here.
    expect(aggregate.usage?.completion_tokens_details).toEqual({
      reasoning_tokens: 832,
      audio_tokens: 0
    })
  })

  test('a usage block with no details still omits the detail keys', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_nd',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
        }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    expect(aggregate.usage && 'prompt_tokens_details' in aggregate.usage).toBe(false)
    expect(aggregate.usage && 'completion_tokens_details' in aggregate.usage).toBe(false)
  })

  test('completed chunk without upstream usage omits the field (no fabricated zeros)', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok' },
      {
        type: 'response.completed',
        response: { id: 'resp_nou', model: 'gpt-5.6-luna', output: [{ type: 'message' }] }
      }
    ]
    const aggregate = await aggregateOpenAiChatSseToJson(driveStream(events))
    expect(aggregate.usage).toBeUndefined()
  })
})

describe('Responses envelope end-to-end — post choices-alignment fix', () => {
  test('convertChatCompletionToResponses gets a non-empty message and returns a populated output', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'm1', type: 'message', content: [] }
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: '391' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_e2e',
          model: 'gpt-5.6-luna',
          output: [{ type: 'message' }],
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }
        }
      }
    ]
    const chatJson = await aggregateOpenAiChatSseToJson(driveStream(events))
    // biome-ignore plugin: the aggregator returns Record<string, unknown> for cross-shape flexibility; the converter widens to ChatCompletionResponse structurally.
    const envelope = convertChatCompletionToResponses(chatJson as never)
    const output = envelope.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('message')
    const content = output[0].content as Array<Record<string, unknown>>
    expect(content[0].text).toBe('391')
    // Reporter's #3: usage should propagate through the Responses envelope.
    expect(envelope.usage).toEqual({ input_tokens: 5, output_tokens: 1, total_tokens: 6 })
  })
})

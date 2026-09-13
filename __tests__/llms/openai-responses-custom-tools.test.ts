/**
 * The Responses custom-tool round trip, end to end.
 *
 * A custom tool (`{type:'custom', name, description, format?}`) is how
 * Codex offers `shell` and friends. #509 taught the request path to carry
 * the definition upstream, but the two return legs were still missing, so
 * a model that answered with one produced nothing at all: against
 * production, `tool_choice:'required'` with a single custom tool came back
 * `{"status":"completed","output":[],"usage":{"output_tokens":13}}` — the
 * model generated a call and the gateway assembled an empty envelope.
 *
 * Three legs have to hold for the loop to close:
 *
 *   1. request `tools[]`            `{type:'custom', …}`      (#509)
 *   2. response `output[]`          `{type:'custom_tool_call', …}`
 *   3. next request `input[]`       `{type:'custom_tool_call_output', …}`
 *
 * Without 2 the call disappears; without 3 the caller cannot hand the
 * result back and the upstream rejects a `function_call_output` naming a
 * call_id it recorded as custom. Both the blocking-JSON and the SSE path
 * are covered, because the real Codex CLI only ever streams.
 */

import { describe, expect, test } from 'bun:test'
import {
  convertChatCompletionToResponses,
  convertResponsesRequestToUnified,
  wrapResponsesEnvelopeAsSse
} from '../../src/llms/transformers/openai/responses/inbound'
import { processNonSystemMessage, remapTools } from '../../src/llms/transformers/openai/responses/request'
import { convertResponseToChat } from '../../src/llms/transformers/openai/responses/response-json'
import { handleStreamEvent } from '../../src/llms/transformers/openai/responses/stream-chunks'
import { aggregateOpenAiChatSseToJson } from '../../src/llms/utils/sse-aggregate'
import { ChatCompletionResponseSchema } from '../../src/schemas/wire/openai/chat'
import { ResponsesAPIPayloadSchema } from '../../src/schemas/wire/openai/responses'

type Bag = Record<string, unknown>

/** Re-run an upstream Responses SSE sequence through the chunk builders
 *  and the chat aggregator, exactly as ResponsesStreamSession does. */
async function aggregateResponsesStream(events: unknown[]): Promise<Bag> {
  const chunks: string[] = []
  for (const event of events) {
    handleStreamEvent(
      event as never,
      () => 0,
      (chunk) => {
        chunks.push(`data: ${JSON.stringify(chunk)}\n\n`)
      }
    )
  }
  chunks.push('data: [DONE]\n\n')
  const response = new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
  return await aggregateOpenAiChatSseToJson(response)
}

function sseEventTypes(sse: string): string[] {
  return sse
    .split(/\n\n/)
    .filter((chunk) => chunk.trim().length > 0)
    .flatMap((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '))
      if (dataLine === undefined) return []
      const parsed: unknown = JSON.parse(dataLine.slice(6))
      const type = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'type') : undefined
      return typeof type === 'string' ? [type] : []
    })
}

describe('custom tool definitions on the request', () => {
  // A freeform-grammar custom tool carries `format` beside the name, and
  // the grammar is the whole point of declaring one — a definition dropped
  // on the way upstream turns a constrained tool into an unconstrained one
  // without saying so.
  test('a custom tool keeps its lark format through the round trip', () => {
    const format = {
      type: 'grammar',
      syntax: 'lark',
      definition: 'start: "SELECT" NAME\nNAME: /[a-z_]+/'
    }
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.6-sol',
      input: 'query the users table',
      tools: [{ type: 'custom', name: 'sql', description: 'Emit one SELECT', format }]
    })
    expect(remapTools(unified.tools)).toEqual([{ type: 'custom', name: 'sql', description: 'Emit one SELECT', format }])
  })
})

describe('custom_tool_call on the way back to the caller', () => {
  test('a blocking-JSON custom_tool_call reaches the caller as a custom_tool_call', () => {
    const upstream = ResponsesAPIPayloadSchema.parse({
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5.6-sol',
      created_at: 1_700_000_000,
      output: [
        {
          id: 'ctc_1',
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'shell',
          input: 'echo hi'
        }
      ],
      usage: { input_tokens: 143, output_tokens: 13, total_tokens: 156 }
    })
    const chat = ChatCompletionResponseSchema.parse(convertResponseToChat(upstream))
    expect(chat.choices?.[0]?.finish_reason).toBe('tool_calls')

    const envelope = convertChatCompletionToResponses(chat)
    const output = envelope.output as Bag[]
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('custom_tool_call')
    expect(output[0].call_id).toBe('call_1')
    expect(output[0].name).toBe('shell')
    expect(output[0].input).toBe('echo hi')
    // The `arguments` spelling belongs to function_call; a custom call
    // carrying one would be read as an empty input by the Codex CLI.
    expect(output[0].arguments).toBeUndefined()
  })

  test('a streamed custom_tool_call survives the chunk builders and the aggregator', async () => {
    const aggregate = await aggregateResponsesStream([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'ctc_1',
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'shell'
        }
      },
      {
        type: 'response.custom_tool_call_input.delta',
        item_id: 'ctc_1',
        output_index: 0,
        delta: 'echo '
      },
      {
        type: 'response.custom_tool_call_input.delta',
        item_id: 'ctc_1',
        output_index: 0,
        delta: 'hi'
      },
      {
        type: 'response.custom_tool_call_input.done',
        item_id: 'ctc_1',
        output_index: 0,
        input: 'echo hi'
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.6-sol',
          output: [{ type: 'custom_tool_call' }],
          usage: { input_tokens: 143, output_tokens: 13, total_tokens: 156 }
        }
      }
    ])
    const chat = ChatCompletionResponseSchema.parse(aggregate)
    // A stream that ends on a tool call must say so: `stop` makes the
    // Codex CLI treat the turn as finished and never run the tool.
    expect(chat.choices?.[0]?.finish_reason).toBe('tool_calls')

    const envelope = convertChatCompletionToResponses(chat)
    const output = envelope.output as Bag[]
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('custom_tool_call')
    expect(output[0].call_id).toBe('call_1')
    expect(output[0].name).toBe('shell')
    expect(output[0].input).toBe('echo hi')
  })

  test('the re-emitted SSE stream carries the custom-tool input events', () => {
    const sse = wrapResponsesEnvelopeAsSse({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.6-sol',
      output: [
        {
          id: 'ctc_1',
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'shell',
          input: 'echo hi'
        }
      ]
    })
    const types = sseEventTypes(sse)
    expect(types).toContain('response.output_item.added')
    expect(types).toContain('response.custom_tool_call_input.delta')
    expect(types).toContain('response.custom_tool_call_input.done')
    expect(types).toContain('response.output_item.done')
    expect(sse).toContain('"delta":"echo hi"')
    expect(sse).toContain('"input":"echo hi"')
    // function_call's own events name a field the custom item does not
    // have; emitting them would hand the caller an empty argument string.
    expect(types).not.toContain('response.function_call_arguments.delta')
  })
})

describe('custom_tool_call_output on the next request', () => {
  test('the caller replay of a custom call and its result reaches the upstream unchanged', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.6-sol',
      input: [
        { type: 'message', role: 'user', content: 'Run: echo hi' },
        {
          type: 'custom_tool_call',
          id: 'ctc_1',
          call_id: 'call_1',
          name: 'shell',
          input: 'echo hi'
        },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'hi\n' }
      ]
    })

    const input: unknown[] = []
    for (const message of unified.messages) {
      processNonSystemMessage(message, input)
    }

    expect(input).toEqual([
      { role: 'user', content: 'Run: echo hi' },
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'shell',
        input: 'echo hi'
      },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'hi\n' }
    ])
  })

  // The two output kinds are not interchangeable upstream: a
  // `function_call_output` naming a call_id the model made as a custom
  // call is a 400, and so is the mirror image. A request that mixes both
  // kinds has to keep each one on its own side.
  test('function and custom results keep their own output kinds side by side', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'function_call',
          call_id: 'call_fn',
          name: 'get_weather',
          arguments: '{"city":"tokyo"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_fn',
          output: '{"temp":30}'
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_sh',
          name: 'shell',
          input: 'echo hi'
        },
        { type: 'custom_tool_call_output', call_id: 'call_sh', output: 'hi\n' }
      ]
    })

    const input: unknown[] = []
    for (const message of unified.messages) {
      processNonSystemMessage(message, input)
    }

    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_fn',
        name: 'get_weather',
        arguments: '{"city":"tokyo"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_fn',
        output: '{"temp":30}'
      },
      {
        type: 'custom_tool_call',
        call_id: 'call_sh',
        name: 'shell',
        input: 'echo hi'
      },
      { type: 'custom_tool_call_output', call_id: 'call_sh', output: 'hi\n' }
    ])
  })

  test('a non-string custom_tool_call_output is serialised, as the function kind already is', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'call_1',
          output: { ok: true }
        }
      ]
    })
    const input: unknown[] = []
    for (const message of unified.messages) {
      processNonSystemMessage(message, input)
    }
    expect(input).toEqual([
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: '{"ok":true}'
      }
    ])
  })
})

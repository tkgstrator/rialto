/**
 * An Anthropic reply on its way back to an OpenAI-surface caller.
 *
 * The Claude steps turn Anthropic's stream into Chat chunks event by event
 * (`response-to-chat-stream.ts`), and the surface's own endpoint converter
 * takes those the rest of the way — for `/v1/responses`, into the
 * Responses events the Codex CLI reads. Both legs are run here, the way
 * the pipeline runs them: provider step `transformResponseOut`, then the
 * endpoint's `transformResponseIn`.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai'
import { aggregateOpenAiChatSseToJson, findSseStreamDefect } from '../../src/llms/utils/sse-aggregate'
import type { TransformerContext } from '../../src/schemas/domain'
import liteTurn1Fixture from '../fixtures/codex/cli-0.160-lite-turn1.json'

type Bag = Record<string, unknown>

const ctx: TransformerContext = {}

const frame = (event: Bag): string => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
const anthropicSse = (events: Bag[]): Response =>
  new Response(events.map(frame).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })

const dataLines = async (response: Response): Promise<string[]> =>
  (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())

const payloads = async (response: Response): Promise<Bag[]> =>
  (await dataLines(response)).filter((data) => data !== '[DONE]').map((data) => Object(JSON.parse(data)))

const deltasOf = (chunks: Bag[]): unknown[] => chunks.map((chunk) => Object(Object(chunk.choices)[0]).delta)

const START: Bag = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 }
  }
}
const blockStart = (index: number, block: Bag): Bag => ({ type: 'content_block_start', index, content_block: block })
const blockDelta = (index: number, delta: Bag): Bag => ({ type: 'content_block_delta', index, delta })
const blockStop = (index: number): Bag => ({ type: 'content_block_stop', index })
const messageDelta = (stopReason: string, outputTokens: number): Bag => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason, stop_sequence: null },
  usage: { output_tokens: outputTokens }
})
const STOP: Bag = { type: 'message_stop' }

// Thinking, then text, then a tool call whose input arrives split.
const THINK_TEXT_TOOL: Bag[] = [
  START,
  blockStart(0, { type: 'thinking', thinking: '' }),
  blockDelta(0, { type: 'thinking_delta', thinking: 'Let me look.' }),
  blockDelta(0, { type: 'signature_delta', signature: 'sig_1' }),
  blockStop(0),
  blockStart(1, { type: 'text', text: '' }),
  blockDelta(1, { type: 'text_delta', text: 'Listing ' }),
  blockDelta(1, { type: 'text_delta', text: 'now.' }),
  blockStop(1),
  { type: 'ping' },
  blockStart(2, { type: 'tool_use', id: 'toolu_1', name: 'ls', input: {} }),
  blockDelta(2, { type: 'input_json_delta', partial_json: '' }),
  blockDelta(2, { type: 'input_json_delta', partial_json: '{"pa' }),
  blockDelta(2, { type: 'input_json_delta', partial_json: 'th": "."}' }),
  blockStop(2),
  messageDelta('tool_use', 42),
  STOP
]

const toChat = (events: Bag[]): Promise<Response> =>
  new ClaudeCodeOauthTransformer().transformResponseOut(anthropicSse(events), ctx)

describe('Anthropic SSE → Chat SSE', () => {
  test('each event becomes the chat chunk a Chat client reads, in order', async () => {
    const chunks = await payloads(await toChat(THINK_TEXT_TOOL))
    expect(deltasOf(chunks)).toEqual([
      { role: 'assistant', content: '' },
      { thinking: { content: 'Let me look.' } },
      { thinking: { signature: 'sig_1' } },
      { content: 'Listing ' },
      { content: 'now.' },
      { tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'ls', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'th": "."}' } }] },
      {}
    ])
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk' && chunk.id === 'msg_1')).toBe(true)
    const last = chunks.at(-1)
    expect(Object(Object(last?.choices)[0]).finish_reason).toBe('tool_calls')
    // Cache read and write are part of the prompt; the read is named.
    expect(last?.usage).toEqual({
      prompt_tokens: 117,
      completion_tokens: 42,
      total_tokens: 159,
      prompt_tokens_details: { cached_tokens: 100 }
    })
  })

  test('the stream ends with [DONE] after message_stop, and the API-key step converts it the same', async () => {
    const subscription = await dataLines(await toChat(THINK_TEXT_TOOL))
    const apiKey = await dataLines(
      await new AnthropicTransformer().transformResponseOut(anthropicSse(THINK_TEXT_TOOL), ctx)
    )
    expect(subscription.at(-1)).toBe('[DONE]')
    const stable = (lines: string[]) => lines.map((line) => line.replace(/"created":\d+/, ''))
    expect(stable(apiKey)).toEqual(stable(subscription))
  })

  test('folds into the chat.completion a stream:false Chat caller would get', async () => {
    const folded = await aggregateOpenAiChatSseToJson(await toChat(THINK_TEXT_TOOL))
    const choice = Object(Object(folded.choices)[0])
    expect(choice.message).toEqual({
      role: 'assistant',
      content: 'Listing now.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'ls', arguments: '{"path": "."}' } }]
    })
    expect(choice.finish_reason).toBe('tool_calls')
  })

  test('a tool call that streams no input closes with an empty object', async () => {
    const chunks = await payloads(
      await toChat([
        START,
        blockStart(0, { type: 'tool_use', id: 'toolu_2', name: 'now', input: {} }),
        blockStop(0),
        messageDelta('tool_use', 3),
        STOP
      ])
    )
    expect(deltasOf(chunks).slice(1, 3)).toEqual([
      { tool_calls: [{ index: 0, id: 'toolu_2', type: 'function', function: { name: 'now', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }
    ])
  })

  test("server tool blocks are Anthropic's to run, and are not handed to the client", async () => {
    const chunks = await payloads(
      await toChat([
        START,
        blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"x"}' }),
        blockStop(0),
        blockStart(1, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] }),
        blockStop(1),
        blockStart(2, { type: 'text', text: '' }),
        blockDelta(2, { type: 'text_delta', text: 'Found it.' }),
        blockStop(2),
        messageDelta('end_turn', 9),
        STOP
      ])
    )
    expect(deltasOf(chunks)).toEqual([{ role: 'assistant', content: '' }, { content: 'Found it.' }, {}])
  })

  test('an error event becomes the error chunk the repo writes for an upstream failure, and nothing after it', async () => {
    const response = await toChat([
      START,
      blockStart(0, { type: 'text', text: '' }),
      blockDelta(0, { type: 'text_delta', text: 'Hel' }),
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      blockDelta(0, { type: 'text_delta', text: 'lo' })
    ])
    const raw = await response.text()
    const lines = raw.split('\n').filter((line) => line.startsWith('data:'))
    expect(JSON.parse(String(lines.at(-1)).slice(5))).toEqual({
      error: { message: 'Overloaded', type: 'overloaded_error', code: null, param: null }
    })
    expect(raw).not.toContain('[DONE]')
    expect(raw).not.toContain('"lo"')
    // A stream:false Chat caller is answered with the status, not a 200 husk.
    expect(findSseStreamDefect(raw)).toMatchObject({ reason: 'upstream-error', status: 529 })
  })

  test('a stream that is not Anthropic passes through untouched', async () => {
    const chat =
      'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
    const response = await new AnthropicTransformer().transformResponseOut(
      new Response(chat, { headers: { 'content-type': 'text/event-stream' } }),
      ctx
    )
    expect(await response.text()).toBe(chat)
  })
})

// ─── …and on to a Responses caller ────────────────────────────────────

const responsesEvents = async (anthropic: Response, context: TransformerContext): Promise<Bag[]> => {
  const chat = await new ClaudeCodeOauthTransformer().transformResponseOut(anthropic, context)
  return payloads(await new OpenAIResponsesTransformer().transformResponseIn(chat, context))
}

describe('Anthropic SSE → Chat SSE → Responses SSE', () => {
  test('text and a function call reach the Responses caller as items, with usage', async () => {
    const events = await responsesEvents(anthropicSse(THINK_TEXT_TOOL), ctx)
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed'
    ])
    const completed = Object(events.at(-1)?.response)
    expect(completed.output).toEqual([
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: 'Listing now.', annotations: [] }]
      }),
      expect.objectContaining({ type: 'function_call', call_id: 'toolu_1', name: 'ls', arguments: '{"path": "."}' })
    ])
    expect(completed.usage).toEqual({ input_tokens: 117, output_tokens: 42, total_tokens: 159 })
  })

  test('an upstream error reaches the Responses caller as response.failed, not as a completed turn', async () => {
    const events = await responsesEvents(
      anthropicSse([
        START,
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'Hel' }),
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      ]),
      ctx
    )
    expect(events.some((event) => event.type === 'response.completed')).toBe(false)
    const failed = events.at(-1)
    expect(failed?.type).toBe('response.failed')
    expect(Object(failed?.response)).toMatchObject({
      status: 'failed',
      error: { code: 'server_is_overloaded', message: 'Overloaded' }
    })
  })

  describe('a Codex CLI Lite caller', () => {
    const lite: TransformerContext = {
      req: {
        headers: {},
        body: liteTurn1Fixture.body,
        url: '/v1/responses',
        surface: 'openai-responses',
        isSubagent: false
      }
    }
    const JS = 'const r = await tools.exec_command({cmd: "echo hi"});\ntext(r.output)'
    // Claude calls the lowered `exec` with its JavaScript under `input`,
    // the JSON split wherever the model's tokens fall.
    const execCall = JSON.stringify({ input: JS })
    const EXEC: Bag[] = [
      START,
      blockStart(0, { type: 'tool_use', id: 'toolu_exec', name: 'exec', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: execCall.slice(0, 17) }),
      blockDelta(0, { type: 'input_json_delta', partial_json: execCall.slice(17, 40) }),
      blockDelta(0, { type: 'input_json_delta', partial_json: execCall.slice(40) }),
      blockStop(0),
      messageDelta('tool_use', 30),
      STOP
    ]

    test('streaming: exec comes back the custom_tool_call the CLI runs, its input the raw JavaScript', async () => {
      const events = await responsesEvents(anthropicSse(EXEC), lite)
      const added = Object(events.find((event) => event.type === 'response.output_item.added')?.item)
      expect(added).toMatchObject({
        type: 'custom_tool_call',
        call_id: 'toolu_exec',
        name: 'exec',
        namespace: 'functions'
      })
      const deltas = events.filter((event) => event.type === 'response.custom_tool_call_input.delta')
      expect(deltas.map((event) => event.delta).join('')).toBe(JS)
      expect(events.find((event) => event.type === 'response.custom_tool_call_input.done')?.input).toBe(JS)
      const done = Object(events.find((event) => event.type === 'response.output_item.done')?.item)
      expect(done).toMatchObject({ type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: JS })
    })

    test('blocking: the same call from a JSON reply', async () => {
      const reply = Response.json({
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id: 'toolu_exec', name: 'exec', input: { input: JS } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      })
      const chat = await new AnthropicTransformer().transformResponseOut(reply, lite)
      const envelope = Object(await (await new OpenAIResponsesTransformer().transformResponseIn(chat, lite)).json())
      expect(envelope.output).toEqual([
        expect.objectContaining({
          type: 'custom_tool_call',
          call_id: 'toolu_exec',
          name: 'exec',
          namespace: 'functions',
          input: JS
        })
      ])
    })

    test('a call into a namespaced function comes back with its namespace', async () => {
      const events = await responsesEvents(
        anthropicSse([
          START,
          blockStart(0, { type: 'tool_use', id: 'toolu_sleep', name: 'sleep', input: {} }),
          blockDelta(0, { type: 'input_json_delta', partial_json: '{"duration_ms":10}' }),
          blockStop(0),
          messageDelta('tool_use', 8),
          STOP
        ]),
        lite
      )
      const done = Object(events.find((event) => event.type === 'response.output_item.done')?.item)
      expect(done).toMatchObject({
        type: 'function_call',
        name: 'sleep',
        namespace: 'clock',
        arguments: '{"duration_ms":10}'
      })
    })
  })
})

describe('Anthropic JSON → chat.completion', () => {
  test('both Claude steps convert a blocking reply; anything else goes back untouched', async () => {
    const reply = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 }
    }
    for (const step of [new AnthropicTransformer(), new ClaudeCodeOauthTransformer()]) {
      const chat = Object(await (await step.transformResponseOut(Response.json(reply), ctx)).json())
      expect(chat.object).toBe('chat.completion')
      expect(Object(Object(chat.choices)[0]).message).toEqual({ role: 'assistant', content: 'pong' })
    }
    const other = { object: 'chat.completion', choices: [] }
    const untouched = await new AnthropicTransformer().transformResponseOut(Response.json(other), ctx)
    expect(await untouched.json()).toEqual(other)
  })
})

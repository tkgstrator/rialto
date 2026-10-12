/**
 * The Responses Lite shape and tool namespaces, leg by leg.
 *
 * Codex CLI 0.160 sends the models it knows a request with no top-level
 * `tools`: they arrive in an `additional_tools` input item, every one of them
 * inside a namespace, and commands run only through `exec` in the
 * `functions` namespace — a custom tool whose input is JavaScript. For that
 * loop to close through Rialto, four things have to hold:
 *
 *   1. request `input[]`     `additional_tools` → the upstream's `tools`
 *   2. response `output[]`   `{type:'custom_tool_call', namespace, name}`
 *                            reaches the CLI with its namespace, which it
 *                            dispatches on
 *   3. next request          the call comes back with its namespace, and
 *                            its output as content parts, not their JSON
 *   4. other wire formats    are sent the tools lowered to functions, and
 *   5.                       the calls their models make are raised back
 *                            to the namespaced / custom calls the CLI runs
 *
 * The whole request chain against the fixtures, through codex-oauth, is in
 * `transformers/codex-request.test.ts`; this file covers the conversions.
 */

import { describe, expect, test } from 'bun:test'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import {
  convertChatCompletionToResponses,
  convertResponsesRequestToUnified,
  wrapResponsesEnvelopeAsSse
} from '../../src/llms/transformers/openai/responses/inbound'
import { processNonSystemMessage } from '../../src/llms/transformers/openai/responses/request'
import { buildRequestBody } from '../../src/llms/utils/gemini-request'
import { aggregateOpenAiChatSseToJson, aggregateOpenAiResponsesSseToJson } from '../../src/llms/utils/sse-aggregate'
import type { RuntimeProvider, TransformerContext } from '../../src/schemas/domain'
import { ChatCompletionResponseSchema } from '../../src/schemas/wire/openai/chat'

type Bag = Record<string, unknown>

const ctx: TransformerContext = {}
const chatProvider: RuntimeProvider = { name: 'openai', api_base_url: 'https://api.openai.com/v1', api_key: 'k' }

const namespace = (name: string, tools: Bag[], description = ''): Bag => ({
  type: 'namespace',
  name,
  description,
  tools
})
const execTool: Bag = {
  type: 'custom',
  name: 'exec',
  description: 'Run JavaScript',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE\nSOURCE: /(.|\\n)+/' }
}
const sleepTool: Bag = {
  type: 'function',
  name: 'sleep',
  description: 'Wait',
  parameters: { type: 'object', properties: { ms: { type: 'number' } } },
  strict: false
}
const additionalTools = (tools: Bag[]): Bag => ({ type: 'additional_tools', id: 'at_1', role: 'developer', tools })

const unifiedMessages = (body: Bag): Bag[] =>
  convertResponsesRequestToUnified(body).messages.map((message) => Object(message))

// The unified request back out to Responses, as openai-responses sends it.
const responsesInput = (body: Bag): Bag[] => {
  const input: unknown[] = []
  for (const message of convertResponsesRequestToUnified(body).messages) processNonSystemMessage(message, input)
  return input.map((item) => Object(item))
}

// ─── 1. The request: additional_tools ─────────────────────────────────

describe('additional_tools in the input', () => {
  test('its tools become unified tools, read exactly as top-level ones', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      input: [
        additionalTools([namespace('functions', [execTool]), sleepTool]),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run echo' }] }
      ]
    })
    expect(unified.tools).toEqual([
      namespace('functions', [execTool]),
      {
        type: 'function',
        function: {
          name: 'sleep',
          description: 'Wait',
          parameters: { type: 'object', properties: { ms: { type: 'number' } } }
        }
      }
    ])
    // The item is a declaration, not a turn of the conversation.
    expect(unified.messages).toEqual([{ role: 'user', content: 'run echo' }])
  })

  test('top-level tools come first, then those of each item in input order', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      tools: [namespace('top', [])],
      input: [
        additionalTools([namespace('first', [])]),
        { type: 'message', role: 'user', content: 'hi' },
        additionalTools([namespace('second', [])])
      ]
    })
    expect((Array.isArray(unified.tools) ? unified.tools : []).map((tool) => Reflect.get(tool, 'name'))).toEqual([
      'top',
      'first',
      'second'
    ])
  })

  test('a name declared twice is kept once: the later declaration, in the earlier one’s place', () => {
    const older = namespace('functions', [execTool], 'older')
    const newer = namespace('functions', [execTool, sleepTool], 'newer')
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      tools: [older, namespace('clock', [sleepTool])],
      input: [additionalTools([newer]), { type: 'message', role: 'user', content: 'hi' }]
    })
    expect(unified.tools).toEqual([newer, namespace('clock', [sleepTool])])
  })

  test('a request that declares no tools anywhere still carries no tools key', () => {
    const unified = convertResponsesRequestToUnified({ model: 'gpt-6-astra', input: 'hi' })
    expect('tools' in unified).toBe(false)
  })
})

// ─── 3. The next request: namespaces and array outputs ────────────────

describe('a namespaced call and its output, handed back', () => {
  test('the namespace of either call kind survives into unified and back out', () => {
    const body = {
      model: 'gpt-6-astra',
      input: [
        { type: 'custom_tool_call', call_id: 'call_x', name: 'exec', namespace: 'functions', input: 'text(1)' },
        { type: 'custom_tool_call_output', call_id: 'call_x', output: 'ok' },
        { type: 'function_call', call_id: 'call_s', name: 'sleep', namespace: 'clock', arguments: '{"ms":1}' },
        { type: 'function_call_output', call_id: 'call_s', output: 'slept' }
      ]
    }
    const [custom, , fn] = unifiedMessages(body)
    expect(custom.tool_calls).toEqual([
      { id: 'call_x', type: 'custom', namespace: 'functions', function: { name: 'exec', arguments: 'text(1)' } }
    ])
    expect(fn.tool_calls).toEqual([
      { id: 'call_s', type: 'function', namespace: 'clock', function: { name: 'sleep', arguments: '{"ms":1}' } }
    ])
    expect(responsesInput(body)).toEqual([
      { type: 'custom_tool_call', call_id: 'call_x', name: 'exec', namespace: 'functions', input: 'text(1)' },
      { type: 'custom_tool_call_output', call_id: 'call_x', output: 'ok' },
      { type: 'function_call', call_id: 'call_s', name: 'sleep', namespace: 'clock', arguments: '{"ms":1}' },
      { type: 'function_call_output', call_id: 'call_s', output: 'slept' }
    ])
  })

  test('a call outside a namespace gets no namespace key', () => {
    const [call] = unifiedMessages({
      model: 'm',
      input: [{ type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{}' }]
    })
    expect(call.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }])
  })

  // An item that fails to parse is dropped whole, so a replayed explicit
  // null (or an empty string) must cost the call its namespace, not the call.
  test('a null or empty namespace is no namespace, and the call survives', () => {
    const messages = unifiedMessages({
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'ls', namespace: null, arguments: '{}' },
        { type: 'custom_tool_call', call_id: 'call_2', name: 'exec', namespace: '', input: 'x' }
      ]
    })
    expect(messages.map((message) => message.tool_calls)).toEqual([
      [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
      [{ id: 'call_2', type: 'custom', function: { name: 'exec', arguments: 'x' } }]
    ])
  })

  test('an output of content parts stays parts, never their JSON', () => {
    const output = [
      { type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: '{"exit_code":0}' }
    ]
    const body = { model: 'gpt-6-astra', input: [{ type: 'custom_tool_call_output', call_id: 'call_x', output }] }
    expect(unifiedMessages(body)[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_x',
      tool_call_type: 'custom',
      content: [
        { type: 'text', text: 'Script completed\nOutput:\n' },
        { type: 'text', text: '{"exit_code":0}' }
      ]
    })
    // The Responses upstream is sent the parts the CLI sent.
    expect(responsesInput(body)).toEqual([{ type: 'custom_tool_call_output', call_id: 'call_x', output }])
  })

  test('an image part is an image, with the media type its data URL names', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo'
    const body = {
      model: 'gpt-6-astra',
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_v',
          output: [
            { type: 'input_text', text: 'the screenshot' },
            { type: 'input_image', image_url: url }
          ]
        }
      ]
    }
    expect(unifiedMessages(body)[0].content).toEqual([
      { type: 'text', text: 'the screenshot' },
      { type: 'image_url', image_url: { url }, media_type: 'image/png' }
    ])
    expect(responsesInput(body)[0].output).toEqual([
      { type: 'input_text', text: 'the screenshot' },
      { type: 'input_image', image_url: url }
    ])
  })

  test('a part unified has no shape for keeps its JSON; an empty output is empty text', () => {
    const file = { type: 'input_file', file_id: 'file_1' }
    const [withFile, empty] = unifiedMessages({
      model: 'm',
      input: [
        { type: 'function_call_output', call_id: 'a', output: [file] },
        { type: 'function_call_output', call_id: 'b', output: [] }
      ]
    })
    expect(withFile.content).toEqual([{ type: 'text', text: JSON.stringify(file) }])
    expect(empty.content).toBe('')
  })
})

// ─── 2. The response: a namespaced call reaches the caller ────────────

const sse = (events: Bag[]): Response =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })

const sseEvents = async (response: Response): Promise<Bag[]> =>
  (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]')
    .map((line) => Object(JSON.parse(line.slice(5))))

// What the Codex backend streams for a code-mode `exec` call followed by a
// call into the `clock` namespace.
const NAMESPACED_CALLS: Bag[] = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-astra', output: [] } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'ctc_1', type: 'custom_tool_call', call_id: 'call_exec1', name: 'exec', namespace: 'functions' }
  },
  { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 0, delta: 'text(' },
  { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 0, delta: '"hi")' },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_sleep1', name: 'sleep', namespace: 'clock' }
  },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"ms":10}' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-6-astra',
      output: [{ type: 'custom_tool_call' }, { type: 'function_call' }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }
  }
]

// Both call items, in the shape every event that carries an item has to
// hand the CLI.
const EXPECTED_CALLS = [
  { type: 'custom_tool_call', call_id: 'call_exec1', name: 'exec', namespace: 'functions', input: 'text("hi")' },
  { type: 'function_call', call_id: 'call_sleep1', name: 'sleep', namespace: 'clock', arguments: '{"ms":10}' }
]

// Upstream Responses SSE → chat SSE (provider chain) → Responses SSE
// (the endpoint), as a Codex reply reaches a Responses client.
async function relayStream(events: Bag[]): Promise<Response> {
  const transformer = new OpenAIResponsesTransformer()
  const chat = await transformer.transformResponseOut(sse(events), ctx)
  return transformer.transformResponseIn(chat, ctx)
}

describe('a namespaced call on the way back to a Responses caller', () => {
  test('streaming: output_item.added and .done carry the namespace', async () => {
    const events = await sseEvents(await relayStream(NAMESPACED_CALLS))
    const items = (type: string): Bag[] =>
      events.filter((event) => event.type === type).map((event) => Object(event.item))
    for (const type of ['response.output_item.added', 'response.output_item.done']) {
      expect(items(type).map((item) => [item.type, item.name, item.namespace])).toEqual([
        ['custom_tool_call', 'exec', 'functions'],
        ['function_call', 'sleep', 'clock']
      ])
    }
    expect(events.find((event) => event.type === 'response.custom_tool_call_input.done')?.input).toBe('text("hi")')
  })

  test('streaming: response.completed replays both items with their namespace', async () => {
    const events = await sseEvents(await relayStream(NAMESPACED_CALLS))
    const completed = Object(events.find((event) => event.type === 'response.completed')?.response)
    expect(completed.output).toHaveLength(2)
    expect(completed.output[0]).toMatchObject(EXPECTED_CALLS[0])
    expect(completed.output[1]).toMatchObject(EXPECTED_CALLS[1])
  })

  test('blocking: the envelope a stream:false caller is handed carries it too', async () => {
    // The /v1/responses surface folds the stream it produced with its own
    // aggregator, which reads `response.completed`.
    const envelope = await aggregateOpenAiResponsesSseToJson(await relayStream(NAMESPACED_CALLS))
    const output = Array.isArray(envelope.output) ? envelope.output : []
    expect(output[0]).toMatchObject(EXPECTED_CALLS[0])
    expect(output[1]).toMatchObject(EXPECTED_CALLS[1])
  })

  test('blocking: a JSON upstream reply keeps the namespace through chat and back', async () => {
    const transformer = new OpenAIResponsesTransformer()
    const upstream = new Response(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-6-astra',
        created_at: 1_700_000_000,
        output: [
          {
            id: 'ctc_1',
            type: 'custom_tool_call',
            call_id: 'call_exec1',
            name: 'exec',
            namespace: 'functions',
            input: 'text("hi")'
          }
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    const chat = await transformer.transformResponseOut(upstream, ctx)
    const envelope = Object(await (await transformer.transformResponseIn(chat, ctx)).json())
    expect(envelope.output).toEqual([expect.objectContaining(EXPECTED_CALLS[0])])
  })

  test('the buffered fallback (chat aggregate → envelope → SSE) carries it as well', async () => {
    const chat = await new OpenAIResponsesTransformer().transformResponseOut(sse(NAMESPACED_CALLS), ctx)
    const parsed = ChatCompletionResponseSchema.safeParse(await aggregateOpenAiChatSseToJson(chat))
    if (!parsed.success) throw new Error('the aggregate is not a chat completion')
    const envelope = convertChatCompletionToResponses(parsed.data)
    const output = Array.isArray(envelope.output) ? envelope.output : []
    expect(output[0]).toMatchObject(EXPECTED_CALLS[0])
    expect(output[1]).toMatchObject(EXPECTED_CALLS[1])
    const replayed = await sseEvents(new Response(wrapResponsesEnvelopeAsSse(envelope)))
    const added = replayed.filter((event) => event.type === 'response.output_item.added').map((e) => Object(e.item))
    expect(added.map((item) => item.namespace)).toEqual(['functions', 'clock'])
  })

  test('a call outside a namespace is handed back with no namespace key', async () => {
    const events = await sseEvents(
      await relayStream([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'ls' }
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{}' },
        { type: 'response.completed', response: { id: 'r', output: [{ type: 'function_call' }] } }
      ])
    )
    const done = events.filter((event) => event.type === 'response.output_item.done').map((e) => Object(e.item))
    expect(done).toHaveLength(1)
    expect('namespace' in done[0]).toBe(false)
  })

  // An upstream that states `namespace: null` on a top-level call must not
  // fail the event's parse: a dropped `output_item.added` is a lost call.
  test('an upstream namespace: null still delivers the call, with no namespace key', async () => {
    const events = await sseEvents(
      await relayStream([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'ls', namespace: null }
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{}' },
        { type: 'response.completed', response: { id: 'r', output: [{ type: 'function_call' }] } }
      ])
    )
    const done = events.filter((event) => event.type === 'response.output_item.done').map((e) => Object(e.item))
    expect(done.map((item) => [item.type, item.name, item.arguments])).toEqual([['function_call', 'ls', '{}']])
    expect('namespace' in done[0]).toBe(false)
  })
})

// ─── 4. Wire formats that have only functions ─────────────────────────

describe('a Lite request routed to a wire format that has only functions', () => {
  const turn1 = [
    additionalTools([namespace('functions', [execTool]), namespace('clock', [sleepTool])]),
    { type: 'message', role: 'user', content: 'run echo' }
  ]
  const lite = (history: Bag[] = []) =>
    convertResponsesRequestToUnified({ model: 'gpt-6-astra', tool_choice: 'auto', input: [...turn1, ...history] })
  const namespacedCall = [
    { type: 'function_call', call_id: 'call_s', name: 'sleep', namespace: 'clock', arguments: '{"ms":1}' },
    { type: 'function_call_output', call_id: 'call_s', output: 'slept' }
  ]
  const customCall = [
    { type: 'custom_tool_call', call_id: 'call_x', name: 'exec', namespace: 'functions', input: 'text("hi")' },
    { type: 'custom_tool_call_output', call_id: 'call_x', output: [{ type: 'input_text', text: 'hi' }] }
  ]
  const functionOf = (tool: unknown): Bag => Object(Reflect.get(Object(tool), 'function'))
  const toChat = (unified: ReturnType<typeof lite>) =>
    new OpenAITransformer().transformRequestIn(unified, chatProvider, ctx)

  test('Chat Completions is sent each namespace member as a function, the custom one taking a string', async () => {
    const out = await toChat(lite())
    const tools = Array.isArray(out.tools) ? out.tools : []
    expect(tools.map((tool) => Reflect.get(tool, 'type'))).toEqual(['function', 'function'])
    // The bare names, as the Codex prompt calls them: neither is ambiguous.
    expect(tools.map((tool) => functionOf(tool).name)).toEqual(['exec', 'sleep'])
    const exec = functionOf(tools[0])
    expect(exec.description).toBe('Run JavaScript')
    expect(exec.parameters).toMatchObject({ type: 'object', required: ['input'], additionalProperties: false })
    const input = Object(Object(exec.parameters).properties).input
    expect(input.type).toBe('string')
    // The grammar the tool's own upstream enforced, so the model can write
    // the input without it.
    expect(input.description).toContain('lark grammar')
    expect(input.description).toContain('start: SOURCE')
    expect(functionOf(tools[1])).toEqual({ name: 'sleep', description: 'Wait', parameters: sleepTool.parameters })
    expect(out.tool_choice).toBe('auto')
  })

  test('Chat Completions is sent the calls in history as function calls, with no namespace or kind', async () => {
    const out = await toChat(lite([...namespacedCall, ...customCall]))
    const calls = out.messages.flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls : []))
    expect(calls).toEqual([
      { id: 'call_s', type: 'function', function: { name: 'sleep', arguments: '{"ms":1}' } },
      { id: 'call_x', type: 'function', function: { name: 'exec', arguments: '{"input":"text(\\"hi\\")"}' } }
    ])
    const results = out.messages.filter((message) => message.role === 'tool')
    expect(results.map((message) => message.tool_call_id)).toEqual(['call_s', 'call_x'])
    expect(results.some((message) => 'tool_call_type' in message)).toBe(false)
  })

  test('a mixed list keeps the declared order, and a function goes out exactly as declared', async () => {
    const ls = { type: 'function', name: 'ls', parameters: { type: 'object' } }
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      tool_choice: 'auto',
      input: 'hi',
      tools: [namespace('clock', [sleepTool]), ls]
    })
    const declaredLs = (Array.isArray(unified.tools) ? unified.tools : [])[1]
    const out = await toChat(unified)
    const tools = Array.isArray(out.tools) ? out.tools : []
    expect(tools.map((tool) => functionOf(tool).name)).toEqual(['sleep', 'ls'])
    expect(tools[1]).toEqual(declaredLs)
    expect(out.tool_choice).toBe('auto')
  })

  test('a name two namespaces share goes out qualified by its namespace', async () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      input: 'hi',
      tools: [namespace('a', [sleepTool]), namespace('b', [sleepTool])]
    })
    const out = await toChat(unified)
    expect((Array.isArray(out.tools) ? out.tools : []).map((tool) => functionOf(tool).name)).toEqual([
      'a__sleep',
      'b__sleep'
    ])
  })

  test('a hosted tool with no function form is dropped, and tool_choice with it when nothing is left', async () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-6-astra',
      tool_choice: 'required',
      input: 'hi',
      tools: [{ type: 'local_shell' }]
    })
    const out = await toChat(unified)
    expect('tools' in out).toBe(false)
    expect('tool_choice' in out).toBe(false)
  })

  test('a request that speaks only in functions reaches Chat as it always did', async () => {
    const unified = convertResponsesRequestToUnified({
      model: 'gpt-5.5',
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' }
      ],
      tools: [{ type: 'function', name: 'ls', parameters: { type: 'object', properties: {} } }]
    })
    const before = structuredClone(unified)
    const out = await toChat(unified)
    expect(out.tools).toEqual(before.tools)
    expect(out.messages).toEqual(before.messages)
  })

  test('Gemini declares the lowered functions, and a custom call in history no longer throws', () => {
    const body = buildRequestBody(lite([...namespacedCall, ...customCall]))
    const declarations = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
      Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : []
    )
    expect(declarations.map((declaration) => declaration.name)).toEqual(['exec', 'sleep'])
    const calls = body.contents.flatMap((content) =>
      content.parts.flatMap((part) => ('functionCall' in part ? [part.functionCall] : []))
    )
    expect(calls.map((call) => [call.name, call.args])).toEqual([
      ['sleep', { ms: 1 }],
      ['exec', { input: 'text("hi")' }]
    ])
    expect(JSON.stringify(body)).not.toContain('namespace')
  })
})

// ─── 5. A call from a function-only upstream, raised for the caller ───

describe('a call into a lowered tool, on the way back to the Responses caller', () => {
  const callerBody: Bag = {
    model: 'gpt-6-astra',
    input: [
      additionalTools([namespace('functions', [execTool]), namespace('clock', [sleepTool])]),
      { type: 'message', role: 'user', content: 'run' }
    ]
  }
  const callerCtx: TransformerContext = {
    req: { headers: {}, body: callerBody, url: '/v1/responses', isSubagent: false }
  }
  const chunk = (delta: Bag): string =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
  const chatStream = (chunks: string[]): Response =>
    new Response([...chunks, 'data: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } })
  // What a function-only upstream streams when the model calls the lowered
  // `exec` (its input split mid-escape) and then `sleep`.
  const LOWERED_CALLS = [
    chunk({ role: 'assistant', content: '' }),
    chunk({
      tool_calls: [{ index: 0, id: 'call_exec1', type: 'function', function: { name: 'exec', arguments: '' } }]
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"input":"const r = await tools.x(\\' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"a\\");\\nr"}' } }] }),
    chunk({
      tool_calls: [{ index: 1, id: 'call_sleep1', type: 'function', function: { name: 'sleep', arguments: '' } }]
    }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '{"ms":10}' } }] })
  ]
  const EXEC_INPUT = 'const r = await tools.x("a");\nr'
  const relay = (chunks: string[], context: TransformerContext = callerCtx) =>
    new OpenAIResponsesTransformer().transformResponseIn(chatStream(chunks), context)

  test('streaming: the custom call comes back a custom_tool_call in its namespace, its input the raw text', async () => {
    const events = await sseEvents(await relay(LOWERED_CALLS))
    const added = events.filter((event) => event.type === 'response.output_item.added').map((e) => Object(e.item))
    expect(added.map((item) => [item.type, item.name, item.namespace])).toEqual([
      ['custom_tool_call', 'exec', 'functions'],
      ['function_call', 'sleep', 'clock']
    ])
    const deltas = events.filter((event) => event.type === 'response.custom_tool_call_input.delta')
    const done = events.find((event) => event.type === 'response.custom_tool_call_input.done')
    expect(deltas.map((event) => event.delta).join('')).toBe(EXEC_INPUT)
    expect(done?.input).toBe(EXEC_INPUT)
    expect(
      events.some(
        (event) =>
          event.type === 'response.function_call_arguments.delta' &&
          event.delta === '{"input":"const r = await tools.x(\\'
      )
    ).toBe(false)
    const completed = Object(events.find((event) => event.type === 'response.completed')?.response)
    expect(completed.output).toEqual([
      expect.objectContaining({
        type: 'custom_tool_call',
        call_id: 'call_exec1',
        name: 'exec',
        namespace: 'functions',
        input: EXEC_INPUT
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_sleep1',
        name: 'sleep',
        namespace: 'clock',
        arguments: '{"ms":10}'
      })
    ])
  })

  test('streaming: a raised function call still streams its arguments as they come', async () => {
    const events = await sseEvents(await relay(LOWERED_CALLS))
    const args = events.filter((event) => event.type === 'response.function_call_arguments.delta')
    expect(args.map((event) => event.delta)).toEqual(['{"ms":10}'])
  })

  test('blocking: the envelope raises both calls the same way', async () => {
    const upstream = Response.json({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_exec1',
                type: 'function',
                function: { name: 'exec', arguments: JSON.stringify({ input: EXEC_INPUT }) }
              },
              { id: 'call_sleep1', type: 'function', function: { name: 'sleep', arguments: '{"ms":10}' } }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    })
    const envelope = Object(
      await (await new OpenAIResponsesTransformer().transformResponseIn(upstream, callerCtx)).json()
    )
    expect(envelope.output).toEqual([
      expect.objectContaining({ type: 'custom_tool_call', name: 'exec', namespace: 'functions', input: EXEC_INPUT }),
      expect.objectContaining({ type: 'function_call', name: 'sleep', namespace: 'clock', arguments: '{"ms":10}' })
    ])
  })

  test('arguments that do not parse to {input} are handed over as the input, untouched', async () => {
    const events = await sseEvents(
      await relay([
        chunk({
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec', arguments: 'ls -la' } }]
        })
      ])
    )
    expect(events.find((event) => event.type === 'response.custom_tool_call_input.done')?.input).toBe('ls -la')
  })

  test('a call whose upstream stated its namespace and kind is never re-raised', async () => {
    // What the Codex backend's reply looks like once converted to chat:
    // it was sent the namespaces verbatim, and says so on the call.
    const codexShaped = [
      chunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'custom', namespace: 'functions', function: { name: 'exec', arguments: '' } }
        ]
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"input":"not json for this tool"}' } }] })
    ]
    const shapes = async (context: TransformerContext) =>
      (await sseEvents(await relay(codexShaped, context)))
        .filter((event) => event.type !== 'response.created' && event.type !== 'response.in_progress')
        .map((event) =>
          JSON.stringify({
            ...event,
            item_id: undefined,
            item: { ...Object(event.item), id: undefined },
            response: undefined
          })
        )
    // The input is the upstream's own text, delivered as it streamed.
    expect(await shapes(callerCtx)).toEqual(await shapes(ctx))
  })

  test('without the caller body (any other surface) nothing is raised', async () => {
    const events = await sseEvents(await relay(LOWERED_CALLS, ctx))
    const added = events.filter((event) => event.type === 'response.output_item.added').map((e) => Object(e.item))
    expect(added.map((item) => [item.type, item.name, 'namespace' in item])).toEqual([
      ['function_call', 'exec', false],
      ['function_call', 'sleep', false]
    ])
  })
})

/**
 * Responses-only tools lowered for the function-only wire formats, and the
 * calls raised back (`src/llms/utils/tool-lowering.ts`).
 *
 * The naming rule is what both directions have to agree on: the request
 * side lowers from the unified tool list, the response side recomputes it
 * from the caller's own body — so the rule may read nothing but the
 * declared list. The Codex CLI fixtures go through the Chat and Gemini
 * outbounds whole; the Claude outbound is in
 * `transformers/anthropic-request-from-unified.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { OpenAITransformer } from '../../src/llms/transformers/openai'
import {
  callerToolLowering,
  convertResponsesRequestToUnified
} from '../../src/llms/transformers/openai/responses/inbound'
import { buildRequestBody } from '../../src/llms/utils/gemini-request'
import {
  customInputOf,
  lowerResponsesTools,
  NO_TOOL_LOWERING,
  raisedCallOf,
  toolLoweringOf
} from '../../src/llms/utils/tool-lowering'
import type { RuntimeProvider, TransformerContext } from '../../src/schemas/domain'
import classicFixture from '../fixtures/codex/cli-0.160-classic.json'
import liteTurn1Fixture from '../fixtures/codex/cli-0.160-lite-turn1.json'
import liteTurn2Fixture from '../fixtures/codex/cli-0.160-lite-turn2.json'

type Bag = Record<string, unknown>

const fn = (name: string): Bag => ({ type: 'function', name, parameters: { type: 'object', properties: {} } })
const ns = (name: string, tools: Bag[]): Bag => ({ type: 'namespace', name, tools })
const custom = (name: string): Bag => ({ type: 'custom', name, format: { type: 'text' } })

const wireNames = (tools: unknown[]): string[] => [...toolLoweringOf(tools).byWireName.keys()]
const unifiedTools = (tools: Bag[]): unknown[] => {
  const unified = convertResponsesRequestToUnified({ model: 'm', input: 'hi', tools })
  return Array.isArray(unified.tools) ? unified.tools : []
}

describe('the wire name of each declared tool', () => {
  test('a namespace member keeps its bare name when no other tool has it', () => {
    expect(
      wireNames(unifiedTools([ns('functions', [custom('exec'), fn('wait')]), ns('clock', [fn('sleep')])]))
    ).toEqual(['exec', 'wait', 'sleep'])
  })

  test('a name two declarations share is qualified by namespace; a top-level function keeps its own', () => {
    const tools = unifiedTools([ns('clock', [fn('sleep')]), fn('sleep'), ns('timer', [fn('sleep')])])
    // `sleep` was declared top-level as well, so only it goes out bare.
    expect(wireNames(tools)).toEqual(['clock__sleep', 'sleep', 'timer__sleep'])
  })

  test('names are fitted to what every function-only wire accepts', () => {
    const tools = unifiedTools([ns('my.tools', [fn('do.thing'), fn('9lives')]), custom('apply patch')])
    expect(wireNames(tools)).toEqual(['do_thing', '_9lives', 'apply_patch'])
    const long = unifiedTools([ns('n', [fn('x'.repeat(80))])])
    expect(wireNames(long)[0]).toHaveLength(64)
  })

  test("a caller's own top-level function goes out under its name, however it is spelt", () => {
    const tools = unifiedTools([fn('mcp.server.tool')])
    expect(wireNames(tools)).toEqual(['mcp.server.tool'])
  })

  test('hosted tools have no function form and get no name', () => {
    expect(wireNames(unifiedTools([{ type: 'local_shell' }, { type: 'image_generation' }]))).toEqual([])
  })

  test('the response side, reading only the caller body, arrives at the names the request side sent', () => {
    for (const fixture of [liteTurn1Fixture, liteTurn2Fixture, classicFixture]) {
      const unified = convertResponsesRequestToUnified(structuredClone(fixture.body))
      const sent = toolLoweringOf(unified.tools)
      const recomputed = callerToolLowering(fixture.body)
      expect([...recomputed.byWireName.entries()]).toEqual([...sent.byWireName.entries()])
    }
  })
})

describe('raising a call', () => {
  const lowering = toolLoweringOf(
    unifiedTools([ns('functions', [custom('exec')]), ns('clock', [fn('sleep')]), fn('ls')])
  )

  test('a call into a lowered tool gets back the kind, name and namespace it was declared with', () => {
    expect(raisedCallOf(lowering, { type: 'function', namespace: undefined, name: 'exec' })).toEqual({
      kind: 'custom',
      name: 'exec',
      namespace: 'functions'
    })
    expect(raisedCallOf(lowering, { type: 'function', namespace: undefined, name: 'sleep' })).toEqual({
      kind: 'function',
      name: 'sleep',
      namespace: 'clock'
    })
  })

  test('never what an upstream stated, a top-level function, or a name nobody lowered', () => {
    expect(raisedCallOf(lowering, { type: 'custom', namespace: 'functions', name: 'exec' })).toBeNull()
    expect(raisedCallOf(lowering, { type: 'function', namespace: 'clock', name: 'sleep' })).toBeNull()
    expect(raisedCallOf(lowering, { type: 'custom', namespace: undefined, name: 'exec' })).toBeNull()
    expect(raisedCallOf(lowering, { type: 'function', namespace: undefined, name: 'ls' })).toBeNull()
    expect(raisedCallOf(lowering, { type: 'function', namespace: undefined, name: 'other' })).toBeNull()
    expect(raisedCallOf(NO_TOOL_LOWERING, { type: 'function', namespace: undefined, name: 'exec' })).toBeNull()
  })

  test("a custom call's input is the text under `input`, or the arguments themselves when they are not that", () => {
    expect(customInputOf('{"input":"echo \\"hi\\""}')).toBe('echo "hi"')
    expect(customInputOf('echo hi')).toBe('echo hi')
    expect(customInputOf('{"cmd":"x"}')).toBe('{"cmd":"x"}')
  })
})

describe('lowering a request', () => {
  test('a request with nothing to lower is the same object', () => {
    const unified = convertResponsesRequestToUnified({
      model: 'm',
      input: 'hi',
      tools: [fn('ls')],
      tool_choice: 'auto'
    })
    expect(lowerResponsesTools(unified)).toBe(unified)
  })

  test('a tool_choice naming a lowered tool names its wire name; one with no function form relaxes to auto', () => {
    const named = lowerResponsesTools(
      convertResponsesRequestToUnified({
        model: 'm',
        input: 'hi',
        tools: [ns('a', [fn('go')]), ns('b', [fn('go')])],
        tool_choice: { type: 'function', name: 'go' }
      })
    )
    expect(named.tool_choice).toEqual({ type: 'function', function: { name: 'a__go' } })
    const custom_ = lowerResponsesTools(
      convertResponsesRequestToUnified({
        model: 'm',
        input: 'hi',
        tools: [custom('apply_patch')],
        tool_choice: { type: 'custom', name: 'apply_patch' }
      })
    )
    expect(custom_.tool_choice).toEqual({ type: 'function', function: { name: 'apply_patch' } })
    const hosted = lowerResponsesTools(
      convertResponsesRequestToUnified({
        model: 'm',
        input: 'hi',
        tools: [custom('apply_patch')],
        tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [] }
      })
    )
    expect(hosted.tool_choice).toBe('auto')
  })
})

// ─── The Codex CLI's own requests, through Chat and Gemini ────────────

const chatProvider: RuntimeProvider = { name: 'openai', api_base_url: 'https://api.openai.com/v1', api_key: 'k' }
const ctx: TransformerContext = {}
const LITE_NAMES = [
  'exec',
  'wait',
  'request_user_input',
  'request_user_input_async',
  'sleep',
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'spawn_agent',
  'wait_agent'
]
const unifiedOf = (fixture: { body: Bag }) => convertResponsesRequestToUnified(structuredClone(fixture.body))

describe('the Codex CLI Lite requests on a function-only wire', () => {
  test('Chat: turn 1 declares every member as a function, exec with its grammar', async () => {
    const out = await new OpenAITransformer().transformRequestIn(unifiedOf(liteTurn1Fixture), chatProvider, ctx)
    const tools = (Array.isArray(out.tools) ? out.tools : []).map((tool) => Object(Reflect.get(tool, 'function')))
    expect(tools.map((tool) => tool.name)).toEqual(LITE_NAMES)
    const input = Object(Object(tools[0].parameters).properties).input
    expect(input.description).toContain('start: SOURCE')
    expect(out.tool_choice).toBe('auto')
  })

  test('Chat: turn 2 sends the exec call as a function call carrying its JavaScript under input', async () => {
    const out = await new OpenAITransformer().transformRequestIn(unifiedOf(liteTurn2Fixture), chatProvider, ctx)
    const calls = out.messages.flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls : []))
    const source = Object(liteTurn2Fixture.body.input[7])
    expect(calls).toEqual([
      {
        id: 'call_exec1',
        type: 'function',
        function: { name: 'exec', arguments: JSON.stringify({ input: source.input }) }
      }
    ])
    expect(JSON.stringify(out)).not.toContain('"namespace"')
    expect(JSON.stringify(out)).not.toContain('tool_call_type')
  })

  test('Gemini: turn 1 declares the same functions', () => {
    const body = buildRequestBody(unifiedOf(liteTurn1Fixture))
    const names = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) =>
      Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations.map((declaration) => declaration.name) : []
    )
    expect(names).toEqual(LITE_NAMES)
  })

  test('Gemini: turn 2 no longer throws on the custom call, and sends its input as an argument', () => {
    const body = buildRequestBody(unifiedOf(liteTurn2Fixture))
    const calls = body.contents.flatMap((content) =>
      content.parts.flatMap((part) => ('functionCall' in part ? [part.functionCall] : []))
    )
    const source = Object(liteTurn2Fixture.body.input[7])
    expect(calls.map((call) => [call.name, call.args])).toEqual([['exec', { input: source.input }]])
  })
})

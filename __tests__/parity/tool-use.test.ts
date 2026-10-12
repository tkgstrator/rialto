/**
 * Parity matrix — the "tool use" row.
 *
 * Tool use is three separate things, and each surface loses a different
 * one:
 *   (a) declaration — the request's `tools[]`
 *   (b) call        — the tool call carried on an assistant turn
 *   (c) result      — the tool's return value carried on a user turn
 *
 * A surface that carries (a) but drops (b) and (c) breaks on multi-turn:
 * the first round trip works and the conversation vanishes on the second,
 * which watching only the declaration will never reveal. So the three are
 * checked apart.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../src/schemas/domain'

const ctx = {} as TransformerContext

const roles = (messages: unknown): unknown[] =>
  Array.isArray(messages) ? messages.map((m) => Reflect.get(Object(m), 'role')) : []

const toolNames = (tools: unknown): unknown[] =>
  Array.isArray(tools) ? tools.map((t) => Reflect.get(Object(Reflect.get(Object(t), 'function')), 'name')) : []

describe('anthropic-messages — supported', () => {
  test('(a) tools[] becomes a unified function tool', async () => {
    const unified = await new AnthropicTransformer().transformRequestOut(
      {
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'Read' }
      },
      ctx
    )
    expect(toolNames(unified.tools)).toEqual(['Read'])
    expect(unified.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } })
  })

  test('(b)(c) tool_use and tool_result survive as a call/result pair', async () => {
    const unified = await new AnthropicTransformer().transformRequestOut(
      {
        model: 'm',
        max_tokens: 16,
        messages: [
          { role: 'user', content: 'read a' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] }
        ]
      },
      ctx
    )
    expect(roles(unified.messages)).toEqual(['user', 'assistant', 'tool'])
    const assistant = Object(unified.messages[1])
    expect(Reflect.get(Object(Reflect.get(assistant, 'tool_calls')), '0')).toMatchObject({
      id: 'tu_1',
      type: 'function',
      function: { name: 'Read', arguments: '{"path":"a"}' }
    })
    expect(Object(unified.messages[2])).toMatchObject({ tool_call_id: 'tu_1', content: 'file body' })
  })

  // That a server tool (web_search_* and friends) declared with only a
  // name still folds into unified is covered by
  // __tests__/llms/transformers/anthropic-request.test.ts.
})

describe('openai-chat — supported by passing through', () => {
  test('(a)(b)(c) all already match unified and pass straight through', async () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'read a' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file body' }
      ],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto'
    }
    const unified = await new OpenAITransformer().transformRequestOut(body, ctx)
    expect(roles(unified.messages)).toEqual(['user', 'assistant', 'tool'])
    expect(toolNames(unified.tools)).toEqual(['Read'])
    expect(unified.tool_choice).toBe('auto')
  })
})

describe('openai-responses — supported', () => {
  test("(a) flat tools are restored to Chat's nested shape", async () => {
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'm',
        input: 'read a',
        tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }],
        tool_choice: { type: 'function', name: 'Read' }
      },
      ctx
    )
    expect(toolNames(unified.tools)).toEqual(['Read'])
    expect(unified.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } })
  })

  test('(b)(c) function_call and function_call_output survive as a call/result pair', async () => {
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a' }] },
          { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'file body' }
        ]
      },
      ctx
    )
    expect(roles(unified.messages)).toEqual(['user', 'assistant', 'tool'])
    expect(Object(unified.messages[2])).toMatchObject({ tool_call_id: 'call_1', content: 'file body' })
  })

  // Codex CLI 0.160's "Responses Lite" shape, which it sends the models it
  // knows: no top-level `tools`, every tool in a namespace, declared in an
  // `additional_tools` input item. That item used to be skipped, so the
  // declaration — and with it every later call — was lost.
  test('(a) the Lite shape: tools declared in an additional_tools input item', async () => {
    const exec = { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: S' } }
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'm',
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'namespace', name: 'functions', tools: [exec] }]
          },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] }
        ],
        tool_choice: 'auto'
      },
      ctx
    )
    expect(unified.tools).toEqual([{ type: 'namespace', name: 'functions', tools: [exec] }])
    expect(roles(unified.messages)).toEqual(['user'])
  })

  test('(b)(c) a namespaced custom_tool_call and its content-part output survive as a call/result pair', async () => {
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
          { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', namespace: 'functions', input: 'ls()' },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'a.ts' }] }
        ]
      },
      ctx
    )
    expect(roles(unified.messages)).toEqual(['user', 'assistant', 'tool'])
    const assistant = Object(unified.messages[1])
    expect(Reflect.get(Object(Reflect.get(assistant, 'tool_calls')), '0')).toMatchObject({
      id: 'call_1',
      type: 'custom',
      namespace: 'functions',
      function: { name: 'exec', arguments: 'ls()' }
    })
    expect(Object(unified.messages[2])).toMatchObject({
      tool_call_id: 'call_1',
      content: [{ type: 'text', text: 'a.ts' }]
    })
  })
})

// The surfaces above read tool use into unified. What a surface's caller
// can do also depends on the provider step getting it out again: routed to
// Claude, unified is converted to Anthropic Messages
// (`anthropic/request-from-unified.ts`), and the namespace / custom tools
// only a Responses caller has are lowered to functions for every
// function-only upstream and raised back on the way out
// (`utils/tool-lowering.ts`). Note (14) in inbound-parity.md.
describe('openai-responses / openai-chat routed to Claude — supported', () => {
  const claude: RuntimeProvider = {
    name: 'anthropic',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: 'k'
  }
  const anthropicBody = async (unified: UnifiedChatRequest): Promise<Record<string, unknown>> =>
    Object(Object(await new AnthropicTransformer().transformRequestIn(unified, claude, ctx)).body)

  test('(a)(b)(c) Responses: a function tool, call and result become tools, tool_use and tool_result', async () => {
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'claude-opus-5-5',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a' }] },
          { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'file body' }
        ],
        tools: [{ type: 'function', name: 'Read', parameters: { type: 'object', properties: {} } }]
      },
      ctx
    )
    const body = await anthropicBody(unified)
    expect(body.tools).toEqual([
      { name: 'Read', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } }
    ])
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read a' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body', cache_control: { type: 'ephemeral' } }
        ]
      }
    ])
  })

  test('(a)(b)(c) Chat: the same, from the Chat shape', async () => {
    const unified = await new OpenAITransformer().transformRequestOut(
      {
        model: 'claude-opus-5-5',
        messages: [
          { role: 'user', content: 'read a' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }]
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'file body' }
        ],
        tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }]
      },
      ctx
    )
    const body = await anthropicBody(unified)
    expect(roles(body.messages)).toEqual(['user', 'assistant', 'user'])
    expect(Object(Object(body.messages)[2]).content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file body', cache_control: { type: 'ephemeral' } }
    ])
  })

  test('(a)(b) the Lite shape: its namespace and custom tools reach Claude as functions', async () => {
    const exec = { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: S' } }
    const unified = await new OpenAIResponsesTransformer().transformRequestOut(
      {
        model: 'claude-opus-5-5',
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'namespace', name: 'functions', tools: [exec] }]
          },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
          { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', namespace: 'functions', input: 'ls()' },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'a.ts' }] }
        ]
      },
      ctx
    )
    const body = await anthropicBody(unified)
    expect(Object(Object(body.tools)[0]).name).toBe('exec')
    expect(Object(Object(body.messages)[1]).content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'exec', input: { input: 'ls()' } }
    ])
  })
})

describe('gemini-generate — supported', () => {
  test('(a) functionDeclarations become unified function tools', async () => {
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        contents: [],
        tools: [
          {
            functionDeclarations: [
              { name: 'lookup', description: 'look something up', parameters: { type: 'object', properties: {} } }
            ]
          }
        ]
      },
      ctx
    )
    expect(toolNames(unified.tools)).toEqual(['lookup'])
  })

  test('(b)(c) functionCall and functionResponse survive as a call/result pair', async () => {
    // Gemini packs functionResponse onto a user turn, while unified
    // follows OpenAI in giving each result its own message. So two
    // contents entries produce two messages: assistant and tool.
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: 'ok' } } }] }
        ]
      },
      ctx
    )
    expect(roles(unified.messages)).toEqual(['assistant', 'tool'])
    const assistant = Object(unified.messages[0])
    const call = Object(Reflect.get(Object(Reflect.get(assistant, 'tool_calls')), '0'))
    expect(call).toMatchObject({ type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } })
    // A Gemini functionResponse normally carries no id, so one is
    // synthesised by matching name and arrival order against the calls.
    // Get this wrong and an OpenAI-family provider 400s on a
    // tool_call_id mismatch.
    expect(Object(unified.messages[1])).toMatchObject({
      role: 'tool',
      tool_call_id: Reflect.get(call, 'id'),
      content: 'ok'
    })
  })

  test('(b)(c) repeated calls to the same tool are not mixed up', async () => {
    // Unless the synthesised id is unique per call, the second result
    // binds to the first call — the failure mode of pairing on name
    // alone.
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'lookup', args: { q: 'a' } } },
              { functionCall: { name: 'lookup', args: { q: 'b' } } }
            ]
          },
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'lookup', response: { result: 'A' } } },
              { functionResponse: { name: 'lookup', response: { result: 'B' } } }
            ]
          }
        ]
      },
      ctx
    )
    const calls = Object(Reflect.get(Object(unified.messages[0]), 'tool_calls'))
    const ids = [Reflect.get(Object(calls[0]), 'id'), Reflect.get(Object(calls[1]), 'id')]
    expect(new Set(ids).size).toBe(2)
    expect(Object(unified.messages[1])).toMatchObject({ tool_call_id: ids[0], content: 'A' })
    expect(Object(unified.messages[2])).toMatchObject({ tool_call_id: ids[1], content: 'B' })
  })

  test("supported: Gemini's toolConfig calling mode becomes tool_choice", async () => {
    // Exactly the inverse of `buildToolConfig` on the outbound side. An
    // ANY with a single allowed name means "call that function", so it
    // folds into OpenAI's function form.
    const unified = await new GeminiTransformer().transformRequestOut(
      {
        model: 'gemini-3-pro',
        contents: [],
        toolConfig: { functionCallingConfig: { mode: 'any', allowedFunctionNames: ['lookup'] } }
      },
      ctx
    )
    expect(unified.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } })
  })

  test('supported: reads the upper-case mode the wire actually carries', async () => {
    // Gemini puts AUTO / ANY / NONE on the wire while our own outbound
    // emits lower case, so reading both identically is what keeps a
    // round trip from forking.
    const auto = await new GeminiTransformer().transformRequestOut(
      { model: 'gemini-3-pro', contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } },
      ctx
    )
    expect(auto.tool_choice).toBe('auto')
    const any = await new GeminiTransformer().transformRequestOut(
      { model: 'gemini-3-pro', contents: [], toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
      ctx
    )
    expect(any.tool_choice).toBe('required')
  })

  // The response direction — OpenAI tool_calls → Gemini functionCall
  // parts, including reassembling split argument fragments — is covered
  // by __tests__/llms/gemini-inbound-response.test.ts.
})

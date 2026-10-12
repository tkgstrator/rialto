/**
 * An OpenAI-surface request routed to Claude is sent as Anthropic Messages.
 *
 * Both Claude steps convert on the conversion path — `claude-code-oauth`
 * (subscription) and `anthropic` (API key) — and the body each sends is
 * asserted whole: anything an OpenAI wire format carries that Anthropic
 * does not know is a 400 there, so an extra key is as much a failure as a
 * missing one. The bypass path (`/v1/messages`, the body already
 * Anthropic's) is pinned in `../claude-conversion-pipeline.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../../src/llms/transformers/anthropic'
import type { OauthCredentials } from '../../../src/llms/transformers/oauth-base'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../../src/llms/transformers/openai'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../../src/schemas/domain'
import liteTurn1Fixture from '../../fixtures/codex/cli-0.160-lite-turn1.json'
import liteTurn2Fixture from '../../fixtures/codex/cli-0.160-lite-turn2.json'

type Bag = Record<string, unknown>

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const subscription: RuntimeProvider = {
  name: 'claude-code',
  api_base_url: 'https://api.anthropic.com/v1/messages',
  api_key: 'oauth',
  modelSupportedEfforts: { 'claude-opus-5-5': EFFORTS, 'claude-sonnet-4-6': EFFORTS }
}
const apiKey: RuntimeProvider = {
  name: 'anthropic',
  api_base_url: 'https://api.anthropic.com/v1/messages',
  api_key: 'sk-ant-test'
}

class StubbedClaudeCode extends ClaudeCodeOauthTransformer {
  protected async resolveSubscriptionAuth(): Promise<OauthCredentials> {
    return { token: 'claude-oauth-token' }
  }
}

const contextFor = (surface: 'openai-chat' | 'openai-responses', body: Bag): TransformerContext => ({
  req: {
    headers: {},
    body,
    url: surface === 'openai-chat' ? '/v1/chat/completions' : '/v1/responses',
    surface,
    isSubagent: false
  }
})

const hookOf = (result: unknown): { body: Bag; headers: Bag } => {
  const hook = Object(result)
  return { body: Object(hook.body), headers: Object(Object(hook.config).headers) }
}

async function responsesToClaude(body: Bag, provider: RuntimeProvider, step: 'subscription' | 'api-key') {
  const context = contextFor('openai-responses', body)
  const unified = await new OpenAIResponsesTransformer().transformRequestOut(structuredClone(body), context)
  const transformer = step === 'subscription' ? new StubbedClaudeCode() : new AnthropicTransformer()
  return hookOf(await transformer.transformRequestIn(unified, provider, context))
}

async function chatToClaude(body: Bag, provider: RuntimeProvider = apiKey) {
  const context = contextFor('openai-chat', body)
  const unified = await new OpenAITransformer().transformRequestOut(structuredClone(body), context)
  return hookOf(await new AnthropicTransformer().transformRequestIn(unified, provider, context))
}

// ─── /v1/responses ────────────────────────────────────────────────────

const RESPONSES_TURN: Bag = {
  model: 'claude-opus-5-5',
  instructions: 'Be terse.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is in this picture? Then list the files.' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }
      ]
    },
    { type: 'function_call', call_id: 'call_1', name: 'ls', arguments: '{"path":"."}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.ts\nb.ts' }
  ],
  tools: [
    {
      type: 'function',
      name: 'ls',
      description: 'List files',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      strict: false
    }
  ],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'high', summary: 'auto' },
  max_output_tokens: 2048,
  stream: true,
  store: false,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'thread-1'
}

const RESPONSES_MESSAGES = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this picture? Then list the files.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    ]
  },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'ls', input: { path: '.' } }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'a.ts\nb.ts', cache_control: { type: 'ephemeral' } }
    ]
  }
]

const RESPONSES_TOOLS = [
  {
    name: 'ls',
    description: 'List files',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    cache_control: { type: 'ephemeral' }
  }
]

describe('a Responses caller routed to Claude', () => {
  test('subscription: the body is Anthropic Messages, identity first, effort as output_config', async () => {
    const { body, headers } = await responsesToClaude(RESPONSES_TURN, subscription, 'subscription')
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      system: [
        { type: 'text', text: IDENTITY },
        { type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }
      ],
      messages: RESPONSES_MESSAGES,
      tools: RESPONSES_TOOLS,
      // The Codex CLI's parallel_tool_calls: false, in Anthropic's place.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: 'high' },
      stream: true
    })
    expect(headers).toEqual({
      Authorization: 'Bearer claude-oauth-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'x-api-key': undefined
    })
  })

  test('API key: the same body without the subscription identity, and the key as x-api-key', async () => {
    const { body, headers } = await responsesToClaude(RESPONSES_TURN, apiKey, 'api-key')
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      system: [{ type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } }],
      messages: RESPONSES_MESSAGES,
      tools: RESPONSES_TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      stream: true
    })
    // Both spellings of Authorization unset: the pipeline seeds a bearer of
    // the same key, and the key goes once, as x-api-key.
    expect(headers).toEqual({
      Authorization: undefined,
      'x-api-key': 'sk-ant-test',
      authorization: undefined,
      'anthropic-version': '2023-06-01'
    })
    expect(Object.keys(headers)).toContain('Authorization')
  })

  test('a caller that set no cap gets the documented default, which Anthropic requires', async () => {
    const { max_output_tokens: _cap, ...uncapped } = RESPONSES_TURN
    const { body } = await responsesToClaude(uncapped, apiKey, 'api-key')
    expect(body.max_tokens).toBe(32000)
  })

  test('parallel calls in history make one assistant turn and one user turn of results', async () => {
    const { body } = await responsesToClaude(
      {
        model: 'claude-opus-5-5',
        input: [
          { type: 'message', role: 'user', content: 'read both' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
          { type: 'function_call', call_id: 'call_a', name: 'read', arguments: '{"f":"a"}' },
          { type: 'function_call', call_id: 'call_b', name: 'read', arguments: '{"f":"b"}' },
          { type: 'function_call_output', call_id: 'call_a', output: 'A' },
          { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'B' }] },
          { type: 'message', role: 'user', content: 'and?' }
        ]
      },
      apiKey,
      'api-key'
    )
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read both' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'call_a', name: 'read', input: { f: 'a' } },
          { type: 'tool_use', id: 'call_b', name: 'read', input: { f: 'b' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
          { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'B' }] },
          { type: 'text', text: 'and?', cache_control: { type: 'ephemeral' } }
        ]
      }
    ])
    expect('tools' in body).toBe(false)
    expect('tool_choice' in body).toBe(false)
  })
})

// ─── /v1/chat/completions ─────────────────────────────────────────────

const CHAT_TURN: Bag = {
  model: 'claude-sonnet-4-6',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'high' } }
      ]
    },
    {
      role: 'assistant',
      content: 'Checking both.',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_a', content: '18C' },
    { role: 'tool', tool_call_id: 'call_b', content: '24C' },
    { role: 'user', content: 'Which is warmer?' }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
      }
    }
  ],
  tool_choice: 'required',
  temperature: 1.4,
  top_p: 0.9,
  stop: ['END', '  '],
  max_completion_tokens: 500,
  stream: true,
  stream_options: { include_usage: true },
  reasoning_effort: 'low',
  user: 'u-1',
  n: 1
}

describe('a Chat Completions caller routed to Claude', () => {
  test('the body is Anthropic Messages, and nothing Chat-only goes with it', async () => {
    const { body } = await chatToClaude(CHAT_TURN)
    expect(body).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this.' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking both.' },
            { type: 'tool_use', id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'tool_use', id: 'call_b', name: 'get_weather', input: { city: 'Rome' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: '18C' },
            { type: 'tool_result', tool_use_id: 'call_b', content: '24C' },
            { type: 'text', text: 'Which is warmer?', cache_control: { type: 'ephemeral' } }
          ]
        }
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Weather for a city',
          input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          cache_control: { type: 'ephemeral' }
        }
      ],
      tool_choice: { type: 'any' },
      stop_sequences: ['END'],
      // OpenAI's 0–2 range clamped to Anthropic's 0–1, and top_p left out:
      // the Claude 4 models that take sampling refuse both together.
      temperature: 1,
      stream: true
    })
  })

  test('a model that refuses sampling and forced tool use gets neither', async () => {
    const { body } = await chatToClaude({ ...CHAT_TURN, model: 'claude-opus-5-5' })
    expect('temperature' in body).toBe(false)
    expect('top_p' in body).toBe(false)
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  test('a tool choice naming a function becomes a tool choice naming it', async () => {
    const { body } = await chatToClaude({
      ...CHAT_TURN,
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      parallel_tool_calls: false
    })
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'get_weather', disable_parallel_tool_use: true })
  })

  test('effort reaches output_config only for a level the model reported', async () => {
    const supported = await chatToClaude({ ...CHAT_TURN, reasoning_effort: 'high' }, subscription)
    expect(supported.body.output_config).toEqual({ effort: 'high' })
    const unknown = await chatToClaude({ ...CHAT_TURN, reasoning_effort: 'minimal' }, subscription)
    expect('output_config' in unknown.body).toBe(false)
  })

  test('a strict JSON schema becomes Anthropic structured output; a non-strict one is left out', async () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false
    }
    const strict = await chatToClaude({
      ...CHAT_TURN,
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema, strict: true } }
    })
    expect(strict.body.output_config).toEqual({ format: { type: 'json_schema', schema } })
    const loose = await chatToClaude({
      ...CHAT_TURN,
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema } }
    })
    expect('output_config' in loose.body).toBe(false)
  })
})

// ─── thinking + tool use ──────────────────────────────────────────────

describe('thinking on a turn that continues a tool loop', () => {
  // An OpenAI-family caller never has Anthropic thinking blocks to hand
  // back, and manual thinking requires the last assistant turn of a tool
  // loop to start with one — so manual thinking on such a turn is left out
  // rather than sent as a certain 400.
  const manual = { type: 'enabled', budget_tokens: 2000 }
  const loop: Bag[] = [
    { role: 'user', content: 'list' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }]
    },
    { role: 'tool', tool_call_id: 'c1', content: 'a.ts' }
  ]

  test('manual thinking is left out of a turn that answers a tool call', async () => {
    const { body } = await chatToClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      thinking: manual,
      messages: loop
    })
    expect('thinking' in body).toBe(false)
  })

  test('manual thinking is kept on a turn that starts fresh', async () => {
    const { body } = await chatToClaude({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      thinking: manual,
      messages: [...loop, { role: 'assistant', content: 'a.ts' }, { role: 'user', content: 'thanks' }]
    })
    expect(body.thinking).toEqual(manual)
  })

  test('adaptive thinking is kept either way: it does not require the blocks', async () => {
    const { body } = await chatToClaude({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, messages: loop })
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  test('nothing turns thinking on by itself', async () => {
    const { body } = await chatToClaude({ model: 'claude-opus-5-5', reasoning_effort: 'high', messages: loop })
    expect('thinking' in body).toBe(false)
  })
})

// ─── The Codex CLI's Lite shape ───────────────────────────────────────

type LoweredTool = { name: string; description?: string; input_schema: Bag }

describe('a Codex CLI Lite request routed to Claude', () => {
  const liteToClaude = (fixture: { body: Bag }) =>
    responsesToClaude({ ...structuredClone(fixture.body), model: 'claude-opus-5-5' }, subscription, 'subscription')

  test('turn 1: every namespace member is a tool, exec taking its JavaScript as one string', async () => {
    const { body } = await liteToClaude(liteTurn1Fixture)
    const tools = Array.isArray(body.tools) ? body.tools.map((tool): LoweredTool => Object(tool)) : []
    expect(tools.map((tool) => tool.name)).toEqual([
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
    ])
    const exec = tools[0]
    expect(exec.input_schema).toMatchObject({ type: 'object', required: ['input'], additionalProperties: false })
    const input = Object(Object(exec.input_schema).properties).input
    expect(input.type).toBe('string')
    expect(input.description).toContain('lark grammar')
    expect(input.description).toContain('start: SOURCE')
    // The base prompt the CLI sends as developer messages is the system.
    const system = Array.isArray(body.system) ? body.system.map((block) => Object(block).text) : []
    expect(system[0]).toBe(IDENTITY)
    expect(system[1]).toStartWith('You are Codex')
    expect(JSON.stringify(body.messages)).not.toContain('developer')
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  test('turn 2: the exec call in history is a tool_use taking its input, and its output parts are text', async () => {
    const { body } = await liteToClaude(liteTurn2Fixture)
    const messages = Array.isArray(body.messages) ? body.messages.map((message) => Object(message)) : []
    const [call] = messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((block: Bag) => block.type === 'tool_use') : []
    )
    const source = Object(liteTurn2Fixture.body.input[7])
    expect(call).toEqual({ type: 'tool_use', id: 'call_exec1', name: 'exec', input: { input: source.input } })
    const last = messages.at(-1)
    expect(last.role).toBe('user')
    expect(last.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_exec1',
        content: Object(liteTurn2Fixture.body.input[8]).output.map((part: Bag) => ({ type: 'text', text: part.text })),
        cache_control: { type: 'ephemeral' }
      }
    ])
    expect(JSON.stringify(body)).not.toContain('namespace')
    expect(JSON.stringify(body)).not.toContain('custom_tool_call')
  })
})

// The unified request the Gemini surface's converter produces reaches
// Claude the same way; one case keeps that path honest.
describe('a request from any surface', () => {
  test('converts from unified regardless of which surface produced it', async () => {
    const unified: UnifiedChatRequest = {
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ]
    }
    const context: TransformerContext = { req: { headers: {}, body: {}, url: '/v1beta/models/x', isSubagent: false } }
    const { body } = hookOf(await new AnthropicTransformer().transformRequestIn(unified, apiKey, context))
    expect(body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 32000,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]
    })
  })
})

describe('prompt caching', () => {
  // OpenAI caches a repeated prefix by itself; Anthropic only up to a
  // breakpoint, which an OpenAI caller has no way to place.
  const breakpoints = (body: Bag): number => JSON.stringify(body).split('"cache_control"').length - 1

  test('the tool list, the system prompt and the last block of the conversation each get a breakpoint', async () => {
    const { body } = await chatToClaude(CHAT_TURN)
    expect(Object(Object(body.tools)[0]).cache_control).toEqual({ type: 'ephemeral' })
    expect(Object(Object(body.system)[0]).cache_control).toEqual({ type: 'ephemeral' })
    const last = Object(Object(body.messages).at(-1))
    expect(Object(last.content.at(-1)).cache_control).toEqual({ type: 'ephemeral' })
    expect(breakpoints(body)).toBe(3)
  })

  test('breakpoints a caller set are kept, and the total never passes the four Anthropic allows', async () => {
    const marked = {
      type: 'text',
      text: 'marked',
      cache_control: { type: 'ephemeral' }
    }
    const { body } = await chatToClaude({
      ...CHAT_TURN,
      messages: [
        { role: 'user', content: [marked] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [marked] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [marked] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'last' }
      ]
    })
    expect(breakpoints(body)).toBe(4)
    const last = Object(Object(body.messages).at(-1))
    expect(Object(last.content.at(-1)).cache_control).toEqual({ type: 'ephemeral' })
  })
})

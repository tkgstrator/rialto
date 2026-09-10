/**
 * Routing signals for the two OpenAI-compat inbound surfaces.
 *
 * Two layers, deliberately:
 *   - `readSignals` on its own — a pure function of (body, inboundPath),
 *     so each of the five signals can be pinned to the exact wire key it
 *     reads. A regression here names the signal it broke.
 *   - `routeScenario` end to end — the point of the exercise. Before the
 *     per-surface readers, an OpenAI caller marked `routed` still only
 *     ever classified as `default`, because none of the fields the other
 *     lanes test for exist under Anthropic's names.
 *
 * The readers see the RAW inbound body on purpose. The endpoint
 * transformers that normalise these shapes run inside the pipeline,
 * which is after `buildRoutePlan` has already routed the request.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeScenario } from '../../src/llms/scenario-router'
import { readSignals } from '../../src/llms/scenario-router/surface-signals'
import type { RouterRequest, RouterRequestBody } from '../../src/llms/scenario-router/types'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests } from '../../src/services/router-preference-service'
import { profileWith } from './chain-fixture'

const CHAT = '/v1/chat/completions'
const RESPONSES = '/v1/responses'

function signals(path: string, body: Record<string, unknown>) {
  const full: RouterRequestBody = { model: 'gpt-5', ...body }
  return readSignals(full, path)
}

describe('tokenize', () => {
  test('responses counts the `input` string that used to weigh zero', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(50)
    const { tokenize } = signals(RESPONSES, { input: long })
    expect(tokenize.messages).toEqual([{ role: 'user', content: long }])
  })

  test('responses reads `instructions` as the system prompt', () => {
    const { tokenize } = signals(RESPONSES, { input: 'ping', instructions: 'You are terse.' })
    expect(tokenize.system).toBe('You are terse.')
  })

  test('responses flattens input_text / output_text blocks and keeps the role', () => {
    const { tokenize } = signals(RESPONSES, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi back' }] }
      ]
    })
    expect(tokenize.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] }
    ])
  })

  test('responses turns function_call / function_call_output into weighable blocks', () => {
    const { tokenize } = signals(RESPONSES, {
      input: [
        { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"/a.ts"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file contents' }
      ]
    })
    expect(tokenize.messages).toEqual([
      // Arguments arrive as a JSON string; decoded so the tokenizer
      // re-serialises the same payload Anthropic's `tool_use.input`
      // would have carried, instead of an escape-inflated copy.
      { role: 'assistant', content: [{ type: 'tool_use', input: { path: '/a.ts' } }] },
      { role: 'tool', content: [{ type: 'tool_result', content: 'file contents' }] }
    ])
  })

  test('responses keeps malformed tool arguments as the raw string', () => {
    const { tokenize } = signals(RESPONSES, {
      input: [{ type: 'function_call', name: 'Read', arguments: '{"path":' }]
    })
    expect(tokenize.messages).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', input: '{"path":' }] }])
  })

  test('responses skips reasoning items rather than counting the opaque blob', () => {
    const { tokenize } = signals(RESPONSES, {
      input: [
        { type: 'reasoning', encrypted_content: 'ZmFrZS1ibG9i', summary: [] },
        { type: 'message', role: 'user', content: 'go on' }
      ]
    })
    expect(tokenize.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go on' }] }])
  })

  test('chat reads `messages`, tool call arguments included', () => {
    const { tokenize } = signals(CHAT, {
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'a.ts b.ts' }
      ]
    })
    expect(tokenize.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', input: { cmd: 'ls' } }] },
      { role: 'tool', content: [{ type: 'text', text: 'a.ts b.ts' }] }
    ])
  })

  test('tool declarations become countable on both surfaces', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    const chat = signals(CHAT, {
      tools: [{ type: 'function', function: { name: 'Read', description: 'read a file', parameters: schema } }]
    })
    const responses = signals(RESPONSES, {
      tools: [{ type: 'function', name: 'Read', description: 'read a file', parameters: schema }]
    })
    const expected = [{ name: 'Read', description: 'read a file', input_schema: schema }]
    expect(chat.tokenize.tools).toEqual(expected)
    expect(responses.tokenize.tools).toEqual(expected)
  })

  test('a hosted tool has no schema to weigh and drops out of tokenize', () => {
    const { tokenize } = signals(RESPONSES, { tools: [{ type: 'web_search' }] })
    expect(tokenize.tools).toEqual([])
  })
})

describe('effort and thinking', () => {
  test('chat reads the flat `reasoning_effort`', () => {
    const s = signals(CHAT, { reasoning_effort: 'high' })
    expect(s.effort).toBe('high')
    expect(s.thinking).toBe(true)
  })

  test('responses reads the nested `reasoning.effort`', () => {
    const s = signals(RESPONSES, { reasoning: { effort: 'medium' } })
    expect(s.effort).toBe('medium')
    expect(s.thinking).toBe(true)
  })

  test('both spellings are accepted on both surfaces', () => {
    // One vendor vocabulary; which one a client sends depends on its SDK
    // version, and Rialto's own chat transformer rewrites flat → nested.
    expect(signals(CHAT, { reasoning: { effort: 'high' } }).effort).toBe('high')
    expect(signals(RESPONSES, { reasoning_effort: 'high' }).effort).toBe('high')
  })

  test('the flat spelling wins when a body carries both', () => {
    expect(signals(CHAT, { reasoning_effort: 'high', reasoning: { effort: 'low' } }).effort).toBe('high')
  })

  test('minimal and none fold onto low, the router enum having no lower rung', () => {
    expect(signals(CHAT, { reasoning_effort: 'minimal' }).effort).toBe('low')
    expect(signals(CHAT, { reasoning_effort: 'none' }).effort).toBe('low')
  })

  test('`none` is the explicit opt-OUT, so it is not a thinking request', () => {
    // OpenAI's analogue of Anthropic's `thinking: {type: 'disabled'}`.
    expect(signals(CHAT, { reasoning_effort: 'none' }).thinking).toBe(false)
    expect(signals(RESPONSES, { reasoning: { effort: 'none' } }).thinking).toBe(false)
  })

  test('saying nothing is not an opt-in', () => {
    const s = signals(CHAT, { messages: [{ role: 'user', content: 'hi' }] })
    expect(s.thinking).toBe(false)
    expect(s.effort).toBeUndefined()
  })

  test('a reasoning object without an effort still counts as thinking', () => {
    // Codex CLI sends `reasoning: {summary: 'auto'}`.
    const s = signals(RESPONSES, { reasoning: { summary: 'auto' } })
    expect(s.thinking).toBe(true)
    expect(s.effort).toBeUndefined()
  })

  test('an unknown effort value reads as "said nothing"', () => {
    expect(signals(CHAT, { reasoning_effort: 'turbo' }).effort).toBeUndefined()
  })

  test('the anthropic `thinking` field is not read on an OpenAI surface', () => {
    // A body that would be a think-lane request on /v1/messages must not
    // be one here — the field is not part of this wire format.
    expect(signals(CHAT, { thinking: { type: 'enabled' } }).thinking).toBe(false)
  })
})

describe('toolNames', () => {
  test('chat returns the nested function names', () => {
    const s = signals(CHAT, {
      tools: [
        { type: 'function', function: { name: 'Read' } },
        { type: 'function', function: { name: 'Bash' } }
      ]
    })
    expect(s.toolNames).toEqual(['Read', 'Bash'])
  })

  test('responses reads names off the flat tool entries', () => {
    const s = signals(RESPONSES, {
      tools: [
        { type: 'function', name: 'Read' },
        { type: 'function', name: 'Bash' }
      ]
    })
    expect(s.toolNames).toEqual(['Read', 'Bash'])
  })

  test('a hosted tool is identified by its type, which is what the operator sees', () => {
    const s = signals(RESPONSES, { tools: [{ type: 'web_search' }, { type: 'file_search' }] })
    expect(s.toolNames).toEqual(['web_search', 'file_search'])
  })

  test('no tools is an empty list, not a crash', () => {
    expect(signals(CHAT, {}).toolNames).toEqual([])
    expect(signals(CHAT, { tools: 'nonsense' }).toolNames).toEqual([])
  })
})

describe('webSearch', () => {
  test('responses hosted tool, including the versioned and preview spellings', () => {
    expect(signals(RESPONSES, { tools: [{ type: 'web_search' }] }).webSearch).toBe(true)
    expect(signals(RESPONSES, { tools: [{ type: 'web_search_preview' }] }).webSearch).toBe(true)
    expect(signals(RESPONSES, { tools: [{ type: 'web_search_2025_08_26' }] }).webSearch).toBe(true)
  })

  test('chat function literally named web_search', () => {
    // The Chat wire form, and what Rialto's own Responses→Chat converter
    // emits, so both sides of that conversion agree on one spelling.
    const s = signals(CHAT, { tools: [{ type: 'function', function: { name: 'web_search' } }] })
    expect(s.webSearch).toBe(true)
  })

  test('chat `web_search_options`, which declares no tool entry at all', () => {
    const s = signals(CHAT, { web_search_options: { search_context_size: 'medium' } })
    expect(s.webSearch).toBe(true)
  })

  test('an ordinary tool set does not trip it', () => {
    const s = signals(CHAT, { tools: [{ type: 'function', function: { name: 'Read' } }] })
    expect(s.webSearch).toBe(false)
  })
})

describe('the surfaces stay distinct', () => {
  test('a responses body read as chat sees nothing, and vice versa', () => {
    // The registry lookup is what separates them; if it regressed to one
    // shared reader, one of these two would start counting.
    const body = { input: 'a long enough turn', instructions: 'be terse' }
    expect(signals(RESPONSES, body).tokenize.messages.length).toBe(1)
    expect(signals(CHAT, body).tokenize.messages).toEqual([])
  })
})

// ─── End to end: the signals actually reach the lanes ──────────────────

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'p',
    auth_mode: 'api_key' as const,
    api_key: 'sk-x',
    api_base_url: 'https://example.invalid/v1/chat/completions',
    models: ['fast', 'thinker', 'searcher', 'big']
  }
]

// One distinct model per lane so the assertion names the lane that won.
// A small explicit threshold keeps the longContext case to a fixture the
// eye can check rather than 60k tokens of lorem ipsum.
const LANES = { default: 'p,fast', think: 'p,thinker', webSearch: 'p,searcher', longContext: 'p,big' }

const chainOf = (agent: Partial<typeof LANES>) =>
  profileWith(Object.fromEntries(Object.entries(agent).map(([scenario, target]) => [`${scenario}.agent`, [target]])), {
    longContextThreshold: 500
  })

async function route(
  path: string,
  body: Record<string, unknown>,
  agent: Partial<typeof LANES> = LANES
): Promise<RouterRequest> {
  __setPreferencesForTests({ live: chainOf(agent) })
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const req: RouterRequest = { body: { model: 'caller,own', ...body }, log, inboundPath: path }
  await routeScenario(req, { config, tokenizers })
  return req
}

// Surface modes and the seeded chain live in module-scoped caches shared
// with every other test file in this process, so reset on both sides.
beforeEach(() => {
  __setSurfacesForTests({ 'openai-chat': 'routed', 'openai-responses': 'routed' })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

describe('the lanes are reachable from an OpenAI surface', () => {
  test('chat: reasoning_effort lands on the think lane', async () => {
    const req = await route(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium'
    })
    expect(req.scenarioType).toBe('think')
    expect(req.body.model).toBe('p,thinker')
  })

  test('responses: reasoning.effort lands on the think lane', async () => {
    const req = await route(RESPONSES, { input: 'hi', reasoning: { effort: 'medium' } })
    expect(req.scenarioType).toBe('think')
    expect(req.body.model).toBe('p,thinker')
  })

  test("reasoning_effort 'none' stays on default", async () => {
    // The explicit opt-out. A think lane that swallowed this would put
    // the cheapest traffic on the most expensive slot.
    const req = await route(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none'
    })
    expect(req.scenarioType).toBe('default')
    expect(req.body.model).toBe('p,fast')
  })

  test('chat: a web_search function lands on the webSearch lane', async () => {
    const req = await route(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'web_search' } }]
    })
    expect(req.scenarioType).toBe('webSearch')
    expect(req.body.model).toBe('p,searcher')
  })

  test('responses: the hosted web_search tool lands on the webSearch lane', async () => {
    const req = await route(RESPONSES, { input: 'hi', tools: [{ type: 'web_search' }] })
    expect(req.scenarioType).toBe('webSearch')
    expect(req.body.model).toBe('p,searcher')
  })

  test('responses: a long `input` lands on the longContext lane', async () => {
    // The signal that was structurally unreachable: token counting read
    // `body.messages`, which a Responses caller never sends.
    const req = await route(RESPONSES, { input: 'lorem ipsum dolor sit amet '.repeat(300) })
    expect(req.tokenCount).toBeGreaterThan(500)
    expect(req.scenarioType).toBe('longContext')
    expect(req.body.model).toBe('p,big')
  })

  test('chat: a long tool manifest counts toward the threshold', async () => {
    // `tools[].function` had to be remapped onto TokenizeTool for this;
    // read verbatim, none of its three fields lines up and a big manifest
    // weighed nothing.
    const req = await route(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'lorem ipsum dolor sit amet '.repeat(300),
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    })
    expect(req.tokenCount).toBeGreaterThan(500)
    expect(req.scenarioType).toBe('longContext')
  })

  test('chat: a high effort escalates to longContext when no think lane is set', async () => {
    // `isHeavyRequest` grades high/xhigh/max as heavy. With a think
    // primary configured the think lane outranks it — see the next test —
    // so this drops that lane to isolate the effort mapping.
    const req = await route(
      CHAT,
      { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
      {
        default: LANES.default,
        longContext: LANES.longContext
      }
    )
    expect(req.scenarioType).toBe('longContext')
    expect(req.body.model).toBe('p,big')
  })

  test("chat: a 'minimal' effort suppresses the opus-tier escalation", async () => {
    // Folded onto `low`, which `isHeavyRequest` reads as explicitly
    // light — so an opus-named model no longer drags the request into
    // longContext. Mapping it to undefined instead would let the tier win.
    const req = await route(
      CHAT,
      { model: 'caller,claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'minimal' },
      { default: LANES.default, longContext: LANES.longContext }
    )
    expect(req.scenarioType).toBe('default')
  })

  test('the think lane outranks the effort escalation, as it does on Anthropic', async () => {
    // Consequence of OpenAI having ONE reasoning knob where Anthropic has
    // two: any non-'none' effort is also a reasoning opt-in, so a
    // high-effort request cannot reach longContext while a think primary
    // exists. There is no OpenAI field that says "work hard, don't think".
    const req = await route(CHAT, { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' })
    expect(req.scenarioType).toBe('think')
  })

  test('an ordinary request still lands on default', async () => {
    const req = await route(CHAT, { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.scenarioType).toBe('default')
    expect(req.body.model).toBe('p,fast')
  })
})

/**
 * Routing signals for the two OpenAI-compat inbound surfaces.
 *
 * Two layers, deliberately:
 *   - `readSignals` on its own — a pure function of (body, inboundPath),
 *     so each of the two signals can be pinned to the exact wire key it
 *     reads. A regression here names the signal it broke.
 *   - `routeRequest` end to end — the point of the exercise. The tier map
 *     gates each route on both signals: the prompt's size against
 *     the route's context window, and a web_search tool against whether
 *     the route can run it. Neither exists under Anthropic's names on an
 *     OpenAI caller, so without the per-surface readers both gates would
 *     wave every OpenAI request through.
 *
 * The readers see the RAW inbound body on purpose. The endpoint
 * transformers that normalise these shapes run inside the pipeline,
 * which is after `buildRoutePlan` has already routed the request.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeRequest } from '../../src/llms/router'
import { readSignals } from '../../src/llms/router/surface-signals'
import type { RouterRequest, RouterRequestBody } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import type { TierProfileView } from '../../src/services/tier-route-service'
import { mapWith, route } from './tier-fixture'

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

  test('no tools, or a tools value that is not a list, is false rather than a crash', () => {
    expect(signals(CHAT, {}).webSearch).toBe(false)
    expect(signals(CHAT, { tools: 'nonsense' }).webSearch).toBe(false)
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

// ─── End to end: the signals actually reach the gates ─────────────────

const log = pino({ level: 'silent' })
const tokenizers = new TokenizerRegistry(log)

beforeAll(async () => {
  await tokenizers.initialize()
})

// The caller's model names no Claude family, so it asks for the "other"
// tier. Three routes, one distinct model each, so the assertion names the
// gate that decided: `fast` holds a short prompt and no web search,
// `searcher` can search but holds no more, `big` holds anything.
const ROUTES = mapWith({
  other: [
    route('p', 'haiku', 'fast', { hostsWebSearch: false, contextWindow: 500 }),
    route('p', 'sonnet', 'searcher', { hostsWebSearch: true, contextWindow: 500 }),
    route('p', 'opus', 'big', { hostsWebSearch: false, contextWindow: 1_000_000 })
  ]
})

async function routeOn(
  path: string,
  body: Record<string, unknown>,
  map: TierProfileView = ROUTES
): Promise<RouterRequest> {
  __setTierProfilesForTests({ live: map })
  const req: RouterRequest = { body: { ...body, model: 'caller,own' }, log, inboundPath: path }
  await routeRequest(req, { config: new ConfigStore({}), tokenizers })
  return req
}

// Surface modes and the seeded map live in module-scoped caches shared
// with every other test file in this process, so reset on both sides.
beforeEach(() => {
  __setSurfacesForTests({ 'openai-chat': 'routed', 'openai-responses': 'routed' })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
})

describe('the gates see an OpenAI caller', () => {
  test('an ordinary request goes to the first route, the rest behind it', async () => {
    const req = await routeOn(CHAT, { messages: [{ role: 'user', content: 'hi' }] })
    expect(req.body.model).toBe('p,fast')
    expect(req.resolvedFallbacks).toEqual(['p,searcher', 'p,big'])
  })

  test('chat: a web_search function skips the routes that cannot run it', async () => {
    const req = await routeOn(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'web_search' } }]
    })
    expect(req.body.model).toBe('p,searcher')
    expect(req.resolvedFallbacks).toEqual([])
  })

  test('chat: `web_search_options` alone is a web search request too', async () => {
    const req = await routeOn(CHAT, {
      messages: [{ role: 'user', content: 'hi' }],
      web_search_options: { search_context_size: 'medium' }
    })
    expect(req.body.model).toBe('p,searcher')
  })

  test('responses: the hosted web_search tool skips the routes that cannot run it', async () => {
    const req = await routeOn(RESPONSES, { input: 'hi', tools: [{ type: 'web_search' }] })
    expect(req.body.model).toBe('p,searcher')
  })

  test('a web_search request no route can run is refused, not sent without its tool', async () => {
    const noSearch = mapWith({ other: [route('p', 'haiku', 'fast', { hostsWebSearch: false })] })
    const req = await routeOn(RESPONSES, { input: 'hi', tools: [{ type: 'web_search' }] }, noSearch)
    expect(req.body.model).toBe('caller,own')
    expect(req.routingRefusal).toContain('web_search')
  })

  test('responses: a long `input` skips the routes too small to hold it', async () => {
    // The signal that was structurally unreachable: token counting read
    // `body.messages`, which a Responses caller never sends.
    const req = await routeOn(RESPONSES, { input: 'lorem ipsum dolor sit amet '.repeat(300) })
    expect(req.tokenCount).toBeGreaterThan(500)
    expect(req.body.model).toBe('p,big')
  })

  test('chat: a long tool manifest counts toward the context gate', async () => {
    // `tools[].function` had to be remapped onto TokenizeTool for this;
    // read verbatim, none of its three fields lines up and a big manifest
    // weighed nothing.
    const req = await routeOn(CHAT, {
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
    expect(req.body.model).toBe('p,big')
  })

  test('a prompt no route can hold is refused on an OpenAI surface too', async () => {
    const small = mapWith({ other: [route('p', 'haiku', 'fast', { contextWindow: 500 })] })
    const req = await routeOn(RESPONSES, { input: 'lorem ipsum dolor sit amet '.repeat(300) }, small)
    expect(req.body.model).toBe('caller,own')
    expect(req.routingRefusal).toContain('context window')
  })
})

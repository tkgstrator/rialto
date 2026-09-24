/**
 * The router's pieces around the tier map: which tier a requested model
 * name asks for, which vendor's windows a 429 is charged to, and what the
 * subagent tag still does now that it picks no lane.
 *
 * What the map does with a request — routed, passed through, 429, 400 —
 * is `route-request.test.ts`; which route passes which gate is
 * `tier-router/select.test.ts`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { type RouterRequest, routeRequest, subscriptionKindOf } from '../../src/llms/scenario-router'
import type { RouterRequestBody } from '../../src/llms/scenario-router/types'
import { __setTierProfilesForTests, requestedTierOf } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { mapWith, route } from './tier-fixture'

// ---- the requested tier --------------------------------------------

describe('requestedTierOf', () => {
  test('reads the family out of the model name, whatever surrounds it', () => {
    expect(requestedTierOf('claude-opus-4-7')).toBe('opus')
    expect(requestedTierOf('claude-sonnet-4-5-20250929')).toBe('sonnet')
    expect(requestedTierOf('claude-haiku-4-5')).toBe('haiku')
    expect(requestedTierOf('claude-fable-5')).toBe('fable')
    // A provider-qualified name still names its family.
    expect(requestedTierOf('anthropic,claude-sonnet-5')).toBe('sonnet')
  })

  test('is case-insensitive', () => {
    expect(requestedTierOf('Claude-Opus-4-7')).toBe('opus')
  })

  test('fable wins over opus, the family the caller named first', () => {
    expect(requestedTierOf('claude-fable-opus-mix')).toBe('fable')
  })

  test('a name with no Claude family, or no name at all, is "other"', () => {
    expect(requestedTierOf('gpt-5.5')).toBe('other')
    expect(requestedTierOf('gemini-3-pro')).toBe('other')
    expect(requestedTierOf(undefined)).toBe('other')
  })
})

// ---- which usage window a 429 is charged to ------------------------

describe('subscriptionKindOf', () => {
  const providers = [
    { name: 'claude-code', auth_mode: 'subscription', api_base_url: 'https://api.anthropic.com/v1/messages' },
    { name: 'codex', auth_mode: 'subscription', api_base_url: 'https://chatgpt.com/backend-api/codex' },
    { name: 'openai-sub', auth_mode: 'subscription', api_base_url: 'https://api.openai.com/v1/responses' },
    { name: 'anthropic', auth_mode: 'api_key', api_base_url: 'https://api.anthropic.com/v1/messages' },
    { name: 'elsewhere', auth_mode: 'subscription', api_base_url: 'https://example.invalid/v1' }
  ]

  test('a subscription provider is charged to its vendor by base URL', () => {
    expect(subscriptionKindOf('claude-code', providers)).toBe('claude')
    expect(subscriptionKindOf('codex', providers)).toBe('codex')
    expect(subscriptionKindOf('openai-sub', providers)).toBe('codex')
  })

  test('an api_key provider has no subscription windows, whatever its URL', () => {
    expect(subscriptionKindOf('anthropic', providers)).toBeNull()
  })

  test('an unknown vendor or an unknown provider is null rather than a guess', () => {
    expect(subscriptionKindOf('elsewhere', providers)).toBeNull()
    expect(subscriptionKindOf('missing', providers)).toBeNull()
  })
})

// ---- the subagent tag, through routeRequest ------------------------

const log = pino({ level: 'silent' })
const tokenizers = new TokenizerRegistry()

beforeAll(async () => {
  await tokenizers.initialize()
})

beforeEach(() => {
  __setSurfacesForTests({ 'anthropic-messages': 'routed' })
  __setTierProfilesForTests({
    live: mapWith({
      sonnet: [route('claude-code', 'sonnet', 'claude-sonnet-5'), route('codex', 'sonnet', 'gpt-5.5')]
    })
  })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
})

async function routeWithSystem(
  system: RouterRequestBody['system'],
  model = 'claude-sonnet-4-5'
): Promise<RouterRequest> {
  const req: RouterRequest = {
    body: { model, messages: [{ role: 'user', content: 'hi' }], system },
    log,
    inboundPath: '/v1/messages'
  }
  await routeRequest(req, { config: new ConfigStore({}), tokenizers })
  return req
}

const systemWith = (second: string, first = 'preamble') => [
  { type: 'text', text: first },
  { type: 'text', text: second }
]

const textOf = (system: RouterRequestBody['system'], index: number): string | undefined => {
  const text = Array.isArray(system) ? system[index]?.text : undefined
  return typeof text === 'string' ? text : undefined
}

describe('routeRequest: the subagent tag', () => {
  test('is recorded and stripped, and picks no lane: the tier routes it like any request', async () => {
    const plain = await routeWithSystem(systemWith('You are a helpful assistant.'))
    const tagged = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>'))
    expect(plain.isSubagent).toBe(false)
    expect(tagged.isSubagent).toBe(true)
    expect(tagged.body.model).toBe(plain.body.model)
    expect(tagged.resolvedFallbacks).toEqual(plain.resolvedFallbacks)
    expect(textOf(tagged.body.system, 1)).toBe('')
  })

  test('its value is ignored, even when it names a routable target', async () => {
    // The tag body used to be a `provider,model` pair. Honouring it would
    // route around the map; only its presence is read.
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>codex,gpt-5.5</RIALTO-SUBAGENT-MODEL>'))
    expect(req.body.model).toBe('claude-code,claude-sonnet-5')
  })

  test('is stripped even when the tier has no route and the caller keeps its model', async () => {
    // The marker must never reach an upstream, including on the paths
    // where the map had nothing to say.
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>x</RIALTO-SUBAGENT-MODEL>'), 'gpt-5')
    expect(req.body.model).toBe('gpt-5')
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('an unclosed tag still counts as present and is left as sent', async () => {
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>anthropic,x'))
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('<RIALTO-SUBAGENT-MODEL>anthropic,x')
  })

  test('a tag outside the second system block is not a marker', async () => {
    const req = await routeWithSystem(systemWith('sys', '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>'))
    expect(req.isSubagent).toBe(false)
  })

  test('a single-block system cannot carry the tag', async () => {
    const req = await routeWithSystem([{ type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }])
    expect(req.isSubagent).toBe(false)
  })
})

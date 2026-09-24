/**
 * The router's pieces around the scenario routes: how a request is
 * classified into a scenario and a lane, how Anthropic thinking is read,
 * which vendor's windows a 429 is charged to, and what the subagent tag
 * does on the way through.
 *
 * What the list does with a request — routed, passed through, 429, 400 —
 * is `route-request.test.ts`; which route passes which gate, and how pace
 * orders the rest, is `tier-router/select.test.ts`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { type RouterRequest, routeRequest, subscriptionKindOf } from '../../src/llms/router'
import { isThinkingEnabled } from '../../src/llms/router/request-signals'
import { readSignals } from '../../src/llms/router/surface-signals'
import type { RouterRequestBody } from '../../src/llms/router/types'
import { __setTierProfilesForTests, classify } from '../../src/llms/tier-router/runtime'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { mapWith, route } from './tier-fixture'

// ---- the scenario and the lane -------------------------------------

describe('classify', () => {
  // Every list has a usable route, so no case below is decided by the
  // fall back to Default.
  const everyList = (defaultWindow: number | null = 200_000, constraints: Parameters<typeof mapWith>[1] = {}) => {
    const r = route('claude-code', 'sonnet', 'claude-sonnet-5', { contextWindow: defaultWindow })
    return mapWith(
      {
        default: { agent: [r], subagent: [r] },
        think: { agent: [r], subagent: [r] },
        longContext: { agent: [r], subagent: [r] }
      },
      constraints
    )
  }
  const signals = (over: Partial<Parameters<typeof classify>[1]> = {}) => ({
    requestTokenCount: 1_000,
    thinking: false,
    isSubagent: false,
    ...over
  })

  test('long input first, then thinking, then Default', () => {
    const view = everyList()
    expect(classify(view, signals()).scenario).toBe('default')
    expect(classify(view, signals({ thinking: true })).scenario).toBe('think')
    expect(classify(view, signals({ requestTokenCount: 150_000 })).scenario).toBe('longContext')
    expect(classify(view, signals({ requestTokenCount: 150_000, thinking: true })).scenario).toBe('longContext')
  })

  test('the lane is the subagent tag and nothing else', () => {
    const view = everyList()
    expect(classify(view, signals()).lane).toBe('agent')
    expect(classify(view, signals({ isSubagent: true })).lane).toBe('subagent')
    expect(classify(view, signals({ isSubagent: true, thinking: true }))).toMatchObject({
      scenario: 'think',
      lane: 'subagent'
    })
  })

  test('a prompt that could not be counted is never Long context', () => {
    expect(classify(everyList(), signals({ requestTokenCount: undefined })).scenario).toBe('default')
  })

  test("the threshold is 70% of the Default · agent route's window, and a prompt must be over it", () => {
    const view = everyList(200_000)
    expect(classify(view, signals({ requestTokenCount: 140_000 }))).toMatchObject({
      scenario: 'default',
      threshold: 140_000
    })
    expect(classify(view, signals({ requestTokenCount: 140_001 })).scenario).toBe('longContext')
    // The same number the profile view serves the Routing screen.
    expect(classify(view, signals()).threshold).toBe(view.longContextThreshold)
  })

  test('128k when no Default · agent route resolves to a model with a known window', () => {
    expect(classify(everyList(null), signals()).threshold).toBe(128_000)
    // The subagent lane's window does not stand in for it.
    const subagentOnly = mapWith({
      default: { subagent: [route('claude-code', 'sonnet', 'claude-sonnet-5', { contextWindow: 1_000_000 })] }
    })
    expect(classify(subagentOnly, signals()).threshold).toBe(128_000)
    // Nor does a route that cannot take traffic.
    const off = mapWith({
      default: {
        agent: [route('claude-code', 'sonnet', 'claude-sonnet-5', { contextWindow: 1_000_000, enabled: false })]
      }
    })
    expect(classify(off, signals()).threshold).toBe(128_000)
  })

  test('a tuned threshold is used, kept within [30k, the base]', () => {
    const tuned = (longContextThreshold: number) =>
      classify(everyList(1_000_000, { longContextThreshold }), signals()).threshold
    expect(tuned(200_000)).toBe(200_000)
    expect(tuned(10_000)).toBe(30_000)
    expect(tuned(900_000)).toBe(700_000)
  })

  test('a scenario with no usable route in the lane falls back to Default for that lane', () => {
    const sonnet = route('claude-code', 'sonnet', 'claude-sonnet-5')
    const view = mapWith({
      default: { agent: [sonnet], subagent: [sonnet] },
      think: { agent: [route('claude-code', 'opus', 'claude-opus-4-7', { enabled: false })], subagent: [sonnet] }
    })
    expect(classify(view, signals({ thinking: true }))).toMatchObject({ scenario: 'default', lane: 'agent' })
    expect(classify(view, signals({ thinking: true, isSubagent: true }))).toMatchObject({
      scenario: 'think',
      lane: 'subagent'
    })
    expect(classify(view, signals({ requestTokenCount: 500_000 })).scenario).toBe('default')
  })

  test('Default is Default even when it is empty: passing through is the selector’s answer', () => {
    const view = mapWith({})
    expect(classify(view, signals({ thinking: true }))).toMatchObject({ scenario: 'default', lane: 'agent' })
  })
})

// ---- Anthropic thinking ---------------------------------------------

describe('isThinkingEnabled', () => {
  const body = (thinking: unknown): RouterRequestBody => ({ model: 'claude-sonnet-5', thinking })

  test('enabled and adaptive both opt in', () => {
    expect(isThinkingEnabled(body({ type: 'enabled', budget_tokens: 4096 }))).toBe(true)
    expect(isThinkingEnabled(body({ type: 'adaptive' }))).toBe(true)
  })

  test('disabled, or no thinking field, does not', () => {
    expect(isThinkingEnabled(body({ type: 'disabled' }))).toBe(false)
    expect(isThinkingEnabled({ model: 'claude-sonnet-5' })).toBe(false)
  })

  test('a malformed field is "not thinking" rather than a crash or a Think request', () => {
    expect(isThinkingEnabled(body(null))).toBe(false)
    expect(isThinkingEnabled(body(true))).toBe(false)
    expect(isThinkingEnabled(body('enabled'))).toBe(false)
    expect(isThinkingEnabled(body({ budget_tokens: 4096 }))).toBe(false)
    expect(isThinkingEnabled(body({ type: 1 }))).toBe(false)
  })

  test('is what the /v1/messages signals carry', () => {
    expect(readSignals(body({ type: 'enabled', budget_tokens: 1024 }), '/v1/messages').thinking).toBe(true)
    expect(readSignals(body({ type: 'disabled' }), '/v1/messages').thinking).toBe(false)
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
      default: {
        agent: [route('claude-code', 'sonnet', 'claude-sonnet-5'), route('codex', 'sonnet', 'gpt-5.5')],
        subagent: [route('codex', 'haiku', 'gpt-5.5-mini')]
      }
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
  test('is recorded and stripped, and picks the subagent lane', async () => {
    const plain = await routeWithSystem(systemWith('You are a helpful assistant.'))
    const tagged = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>'))
    expect(plain.isSubagent).toBe(false)
    expect(plain.body.model).toBe('claude-code,claude-sonnet-5')
    expect(tagged.isSubagent).toBe(true)
    expect(tagged.body.model).toBe('codex,gpt-5.5-mini')
    expect(tagged.resolvedFallbacks).toEqual([])
    expect(textOf(tagged.body.system, 1)).toBe('')
  })

  test('its value is ignored, even when it names a routable target', async () => {
    // The tag body used to be a `provider,model` pair. Honouring it would
    // route around the lists; only its presence is read.
    const req = await routeWithSystem(
      systemWith('<RIALTO-SUBAGENT-MODEL>claude-code,claude-sonnet-5</RIALTO-SUBAGENT-MODEL>')
    )
    expect(req.body.model).toBe('codex,gpt-5.5-mini')
  })

  test('is stripped even when the lane has no route and the caller keeps its model', async () => {
    // The marker must never reach an upstream, including on the paths
    // where the lists had nothing to say.
    __setTierProfilesForTests({ live: mapWith({ default: { agent: [route('codex', 'sonnet', 'gpt-5.5')] } }) })
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>x</RIALTO-SUBAGENT-MODEL>'), 'gpt-5')
    expect(req.body.model).toBe('gpt-5')
    expect(req.route).toBe('passthrough')
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('is stripped and recorded on a passthrough surface too, where the caller keeps its model', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'passthrough' })
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>x</RIALTO-SUBAGENT-MODEL>'))
    expect(req.route).toBe('passthrough')
    expect(req.body.model).toBe('claude-sonnet-4-5')
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('an unclosed tag still counts as present and is left as sent', async () => {
    const req = await routeWithSystem(systemWith('<RIALTO-SUBAGENT-MODEL>anthropic,x'))
    expect(req.isSubagent).toBe(true)
    expect(req.body.model).toBe('codex,gpt-5.5-mini')
    expect(textOf(req.body.system, 1)).toBe('<RIALTO-SUBAGENT-MODEL>anthropic,x')
  })

  test('a tag outside the second system block is not a marker', async () => {
    const req = await routeWithSystem(systemWith('sys', '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>'))
    expect(req.isSubagent).toBe(false)
    expect(req.body.model).toBe('claude-code,claude-sonnet-5')
  })

  test('a single-block system cannot carry the tag', async () => {
    const req = await routeWithSystem([{ type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }])
    expect(req.isSubagent).toBe(false)
  })
})

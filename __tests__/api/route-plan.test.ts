/**
 * `buildRoutePlan` — the once-per-request stage.
 *
 * Two things here are new and load-bearing for the gemini surface:
 *
 *   1. The endpoint transformer is looked up by the SURFACE's endpoint
 *      pattern, not by the request path. Gemini's transformer registers
 *      at `/v1beta/models/:modelAndAction`, which no concrete request
 *      path ever equals, so a path-keyed lookup 404s every gemini call.
 *   2. The model and the streaming choice are folded out of the URL and
 *      into the body, because every stage after this one reads
 *      `body.model` / `body.stream`.
 *
 * The other three surfaces must be untouched by both, so they are
 * asserted alongside.
 *
 * On a routed surface the plan is the tier map's answer, and the two
 * outcomes the map hands back as fields — a quota-held tier and a refusal
 * — are answered here without dispatching.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import pino from 'pino'
import { buildRoutePlan, type RoutePlan } from '../../src/api/v1/route-plan'
import dayjs from '../../src/lib/dayjs'
import type { LlmsContext } from '../../src/llms'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAITransformer } from '../../src/llms/transformers/openai'
import { clearModelExhaustion, markModelExhausted } from '../../src/services/failover-state'
import { __setSurfacesForTests, invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { __resetModelHealthForTest, recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { __resetSchedulerStateForTest } from '../../src/services/routing-scheduler/state'
import { mapWith, route } from '../llms/tier-fixture'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'google',
    auth_mode: 'api_key' as const,
    api_style: 'gemini' as const,
    api_key: 'sk-goog',
    api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
    models: ['gemini-3-pro']
  },
  {
    name: 'anthropic',
    auth_mode: 'api_key' as const,
    api_style: 'anthropic' as const,
    api_key: 'sk-ant',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5', 'claude-opus-4-7']
  }
]

async function buildContext(): Promise<LlmsContext> {
  const transformers = new TransformerRegistry(log)
  transformers.registerMany([new AnthropicTransformer(), new OpenAITransformer(), new GeminiTransformer()])
  const providers = new ProviderRegistry(transformers, log)
  providers.registerFromConfig(PROVIDERS)
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  return { config, transformers, providers, tokenizers, log }
}

// Drive buildRoutePlan through a real Hono context, which is the only
// way it reads a body and a URL.
async function plan(
  path: string,
  body: Record<string, unknown>,
  inbound: { headers?: Record<string, string>; tokenId?: string } = {}
): Promise<RoutePlan | Response> {
  const ctx = await buildContext()
  const app = new Hono()
  const captured: { value: RoutePlan | Response | null } = { value: null }
  app.post('/*', async (c) => {
    // The /v1 auth middleware sets this when an issued token authenticated
    // the call; buildRoutePlan reads it back off the context.
    if (inbound.tokenId !== undefined)
      c.set('accessToken', { id: inbound.tokenId, name: 'test', surfaces: [], profileKey: null })
    captured.value = await buildRoutePlan(c, ctx)
    return c.text('ok')
  })
  await app.fetch(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...inbound.headers },
      body: JSON.stringify(body)
    })
  )
  if (captured.value === null) throw new Error('buildRoutePlan never ran')
  return captured.value
}

const asPlan = (result: RoutePlan | Response): RoutePlan => {
  if (result instanceof Response) throw new Error(`expected a plan, got ${result.status}`)
  return result
}

const asResponse = (result: RoutePlan | Response): Response => {
  if (!(result instanceof Response)) throw new Error('expected a response, got a plan')
  return result
}

const SONNET = 'anthropic,claude-sonnet-5'
const OPUS = 'anthropic,claude-opus-4-7'
const sonnetRoute = (over: Parameters<typeof route>[3] = {}) => route('anthropic', 'sonnet', 'claude-sonnet-5', over)
const opusRoute = (over: Parameters<typeof route>[3] = {}) => route('anthropic', 'opus', 'claude-opus-4-7', over)

// The health gate needs `minHealthSamples` (5 by default) failures
// before it holds a route.
const failRepeatedly = (target: string): void => {
  for (const _ of Array.from({ length: 5 })) recordModelFailure(target)
}

const resetLiveState = (): void => {
  __resetSchedulerStateForTest()
  __resetModelHealthForTest()
  clearModelExhaustion('anthropic', 'claude-sonnet-5')
  clearModelExhaustion('anthropic', 'claude-opus-4-7')
}

// Every surface passthrough unless a test says otherwise: the router then
// returns before it can consult the map, and body.model reaches the plan
// verbatim. The empty seed keeps a routed test that forgets its map off
// Postgres.
beforeEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests({})
  resetLiveState()
})

afterEach(() => {
  __setSurfacesForTests({})
  __setTierProfilesForTests(null)
  resetLiveState()
})

/**
 * On a routed surface the plan is the map's answer. Three outcomes reach
 * the /v1 handler in their own shape: a primary with the rest of the
 * tier's routes behind it; no primary and the caller's own model going
 * out alone; or no primary and a 429 that never dispatches at all.
 */
describe('a routed surface walks the tier map', () => {
  const body = () => ({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] })

  beforeEach(() => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed', 'openai-chat': 'routed' })
  })

  test('the plan carries the primary and the rest of the tier as fallbacks', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute(), opusRoute()] }) })
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.fallbacks).toEqual([OPUS])
    expect(result.routedBody.model).toBe(SONNET)
    expect(result.route).toBe('sonnet')
    // What the client asked for is still recorded next to what was sent.
    expect(result.requestedModel).toBe('claude-sonnet-4-5')
  })

  test('no primary under exhaustedBehavior passthrough sends the caller’s own model with no fallbacks', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: 'passthrough' }) })
    failRepeatedly(SONNET)
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe('claude-sonnet-4-5')
    expect(result.fallbacks).toEqual([])
    expect(result.route).toBe('passthrough')
  })

  test('no primary under exhaustedBehavior 429 answers 429 with Retry-After and no plan', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    failRepeatedly(SONNET)
    const response = asResponse(await plan('/v1/messages', body()))
    expect(response.status).toBe(429)
    // Held on health alone, nothing says when the route comes back, so
    // the hint is the default 30 s.
    expect(response.headers.get('Retry-After')).toBe('30')
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } })
  })

  test('the Retry-After is the held route’s own deadline when a 429 set one', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    markModelExhausted('anthropic', 'claude-sonnet-5', dayjs().add(90, 'second').valueOf())
    const response = asResponse(await plan('/v1/messages', body()))
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThanOrEqual(89)
    expect(Number(response.headers.get('Retry-After'))).toBeLessThanOrEqual(90)
  })

  test('the 429 answers in the surface’s own envelope', async () => {
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    failRepeatedly(SONNET)
    const response = asResponse(await plan('/v1/chat/completions', body()))
    expect(response.status).toBe(429)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { type: 'rate_limit_error' } })
    expect(envelope).not.toHaveProperty('type')
  })

  test('an empty tier sends the caller’s own model even under exhaustedBehavior 429', async () => {
    __setTierProfilesForTests({ live: mapWith({ opus: [opusRoute()] }, { exhaustedBehavior: '429' }) })
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe('claude-sonnet-4-5')
    expect(result.fallbacks).toEqual([])
    expect(result.route).toBe('passthrough')
  })
})

describe('the gemini surface', () => {
  test('resolves its transformer through the surface endpoint, not the request path', async () => {
    const result = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect([...result.transformersByName.keys()]).toEqual(['gemini'])
    expect(result.defaultTransformer.name).toBe('gemini')
  })

  test('lands the path model on body.model, which is what every later stage reads', async () => {
    const result = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect(result.routedBody.model).toBe('gemini-3-pro')
    expect(result.primaryModel).toBe('gemini-3-pro')
    // The client asked for this model by URL; recording it as the
    // requested model is what makes the Activity row honest.
    expect(result.requestedModel).toBe('gemini-3-pro')
  })

  test(':streamGenerateContent sets body.stream, which decides SSE vs JSON on the way back', async () => {
    const streaming = asPlan(await plan('/v1beta/models/gemini-3-pro:streamGenerateContent', { contents: [] }))
    expect(streaming.routedBody.stream).toBe(true)
    const blocking = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect(blocking.routedBody.stream).toBe(false)
  })

  test('a provider-qualified model in the path survives intact', async () => {
    const result = asPlan(await plan('/v1beta/models/google,gemini-3-pro:generateContent', { contents: [] }))
    expect(result.primaryModel).toBe('google,gemini-3-pro')
  })

  test('the path wins over a stale body.model', async () => {
    // Google clients do not send one, but if something does, the URL is
    // the request's own statement of what it is calling.
    const result = asPlan(
      await plan('/v1beta/models/gemini-3-pro:generateContent', { model: 'something-else', contents: [] })
    )
    expect(result.primaryModel).toBe('gemini-3-pro')
  })

  test('the path model is what the tier is read from on a routed gemini surface', async () => {
    // gemini-3-pro names no Claude family, so it asks for "other".
    __setSurfacesForTests({ 'gemini-generate': 'routed' })
    __setTierProfilesForTests({ live: mapWith({ other: [route('google', 'sonnet', 'gemini-3-pro')] }) })
    const result = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect(result.primaryModel).toBe('google,gemini-3-pro')
    expect(result.route).toBe('other')
  })
})

describe('the body-carrying surfaces are untouched', () => {
  test('/v1/messages still reads its model from the body', async () => {
    const result = asPlan(await plan('/v1/messages', { model: SONNET, messages: [] }))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.defaultTransformer.name).toBe('anthropic')
  })

  test('/v1/chat/completions keeps the stream flag the caller sent', async () => {
    const result = asPlan(await plan('/v1/chat/completions', { model: 'openai,gpt-5', stream: true, messages: [] }))
    expect(result.routedBody.stream).toBe(true)
    expect(result.defaultTransformer.name).toBe('openai')
  })

  test('a missing model on a body-carrying surface is still a 400', async () => {
    const result = await plan('/v1/messages', { messages: [] })
    expect(asResponse(result).status).toBe(400)
  })
})

describe('paths outside the registry', () => {
  test('404 in the caller-neutral Anthropic envelope, as before', async () => {
    const response = asResponse(await plan('/v1/embeddings', { model: 'x' }))
    expect(response.status).toBe(404)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error' })
  })

  test('a gemini-shaped path with no action gets no model folded in', async () => {
    // `/v1beta/models/gemini-3-pro` has no `:action`, so there is nothing
    // to extract; the request fails on the missing model rather than on a
    // truncated one.
    const result = await plan('/v1beta/models/gemini-3-pro', {})
    expect(asResponse(result).status).toBe(400)
  })
})

describe('the error envelope of a failed plan follows the surface', () => {
  test('a gemini 400 answers in google.rpc.Status shape', async () => {
    invalidateSurfaceCache()
    __setSurfacesForTests({})
    const envelope: unknown = await asResponse(await plan('/v1beta/models/gemini-3-pro', {})).json()
    expect(envelope).toMatchObject({ error: { status: 'INVALID_ARGUMENT', code: 400 } })
  })
})

/**
 * The sub-account sticky key. It is what the OAuth transformer picks an
 * account under and what the reactive 429 path releases, so "the client
 * sent no session header" must not resolve to "no key": that dropped the
 * request onto the provider's stored active account and kept it there,
 * 429 after 429, while its peer accounts sat unspent.
 */
describe('accountSessionKey', () => {
  test('uses the session the client sent', async () => {
    const result = asPlan(
      await plan(
        '/v1/messages',
        { model: SONNET, messages: [] },
        { headers: { 'x-claude-code-session-id': 'sess-1' }, tokenId: 'tok-1' }
      )
    )
    expect(result.accountSessionKey).toBe('sess-1')
  })

  test('falls back to the issued token when the client sends no session', async () => {
    const result = asPlan(await plan('/v1/chat/completions', { model: SONNET, messages: [] }, { tokenId: 'tok-1' }))
    expect(result.accountSessionKey).toBe('token:tok-1')
  })

  test('is stable across requests from the same token, so the pick sticks', async () => {
    const body = { model: SONNET, messages: [] }
    const first = asPlan(await plan('/v1/chat/completions', body, { tokenId: 'tok-1' }))
    const second = asPlan(await plan('/v1/chat/completions', body, { tokenId: 'tok-1' }))
    expect(second.accountSessionKey).toBe(first.accountSessionKey)
  })

  test('an unauthenticated-by-token call still gets a key rather than nothing', async () => {
    const result = asPlan(await plan('/v1/chat/completions', { model: SONNET, messages: [] }))
    expect(result.accountSessionKey).toBe('anonymous')
  })
})

/**
 * A tier with routes that yields no primary is not always exhaustion.
 * Only quota or health earns a 429: a map that is configured but cannot
 * take this request is answered 400, and a tier whose routes are all
 * switched off passes through like an empty one. Claude Code sends its
 * background work as Haiku, which is what made a Sonnet-only chain answer
 * a 429 that never went upstream.
 */
describe('a tier that yields no primary answers by why', () => {
  const haiku = () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] })

  beforeEach(() => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed', 'openai-chat': 'routed', 'gemini-generate': 'routed' })
  })

  test('a haiku request is served by the sonnet route the map gives it', async () => {
    __setTierProfilesForTests({ live: mapWith({ haiku: [sonnetRoute()] }) })
    const result = asPlan(await plan('/v1/messages', haiku()))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.requestedModel).toBe('claude-haiku-4-5')
    expect(result.route).toBe('haiku')
  })

  test('a route with no alias answers 400, not a 429 with Retry-After', async () => {
    __setTierProfilesForTests({
      live: mapWith({ haiku: [route('anthropic', 'haiku', null)] }, { exhaustedBehavior: '429' })
    })
    const response = asResponse(await plan('/v1/messages', haiku()))
    expect(response.status).toBe(400)
    expect(response.headers.get('Retry-After')).toBeNull()
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect(JSON.stringify(envelope)).toContain('no model aliased')
  })

  test('exhaustedBehavior passthrough does not turn a refusal into a pass', async () => {
    // Passthrough is what to do while quota comes back; nothing comes
    // back for a route that has no model behind it.
    __setTierProfilesForTests({
      live: mapWith({ haiku: [route('anthropic', 'haiku', null)] }, { exhaustedBehavior: 'passthrough' })
    })
    expect(asResponse(await plan('/v1/messages', haiku())).status).toBe(400)
  })

  test('a web_search request no route can run is a 400 in the OpenAI envelope on chat', async () => {
    __setTierProfilesForTests({ live: mapWith({ haiku: [sonnetRoute({ hostsWebSearch: false })] }) })
    const response = asResponse(
      await plan('/v1/chat/completions', {
        ...haiku(),
        tools: [{ type: 'function', function: { name: 'web_search' } }]
      })
    )
    expect(response.status).toBe(400)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(envelope).not.toHaveProperty('type')
    expect(JSON.stringify(envelope)).toContain('web_search')
  })

  test('a prompt no route can hold is a 400 in google.rpc.Status shape on gemini', async () => {
    __setTierProfilesForTests({
      live: mapWith({ other: [route('google', 'sonnet', 'gemini-3-pro', { contextWindow: 20 })] })
    })
    const long = 'lorem ipsum dolor sit amet '.repeat(50)
    const response = asResponse(
      await plan('/v1beta/models/gemini-3-pro:generateContent', {
        contents: [{ role: 'user', parts: [{ text: long }] }]
      })
    )
    expect(response.status).toBe(400)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { status: 'INVALID_ARGUMENT', code: 400 } })
  })

  test('a tier whose routes are all switched off passes through like an empty one', async () => {
    __setTierProfilesForTests({
      live: mapWith({ haiku: [sonnetRoute({ enabled: false })] }, { exhaustedBehavior: '429' })
    })
    const result = asPlan(await plan('/v1/messages', haiku()))
    expect(result.primaryModel).toBe('claude-haiku-4-5')
    expect(result.route).toBe('passthrough')
  })

  test('a substitute that is itself failing still answers 429', async () => {
    __setTierProfilesForTests({ live: mapWith({ haiku: [sonnetRoute()] }, { exhaustedBehavior: '429' }) })
    failRepeatedly(SONNET)
    expect(asResponse(await plan('/v1/messages', haiku())).status).toBe(429)
  })
})

/**
 * A passthrough surface may refuse a target the operator switched off for
 * it. The check runs after routing, in the surface's own envelope, and
 * only judges the caller's own model — a routed surface never sends it.
 */
describe('passthrough denial', () => {
  test('a denied target on a passthrough surface is a 400 that names it', async () => {
    __setSurfacesForTests({}, { 'anthropic-messages': [OPUS] })
    const response = asResponse(await plan('/v1/messages', { model: OPUS, messages: [] }))
    expect(response.status).toBe(400)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect(JSON.stringify(envelope)).toContain(`${OPUS} is turned off for /v1/messages`)
  })

  test('a target the list does not name goes through', async () => {
    __setSurfacesForTests({}, { 'anthropic-messages': [OPUS] })
    const result = asPlan(await plan('/v1/messages', { model: SONNET, messages: [] }))
    expect(result.primaryModel).toBe(SONNET)
  })

  test('the list is per surface: another surface may still name the target', async () => {
    __setSurfacesForTests({}, { 'anthropic-messages': [OPUS] })
    const result = asPlan(await plan('/v1/chat/completions', { model: OPUS, messages: [] }))
    expect(result.primaryModel).toBe(OPUS)
  })

  test('a routed surface ignores the list, even when the map lands on a listed target', async () => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed' }, { 'anthropic-messages': [SONNET] })
    __setTierProfilesForTests({ live: mapWith({ sonnet: [sonnetRoute()] }) })
    const result = asPlan(await plan('/v1/messages', { model: 'claude-sonnet-4-5', messages: [] }))
    expect(result.primaryModel).toBe(SONNET)
  })
})

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
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import pino from 'pino'
import { buildRoutePlan, type RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAITransformer } from '../../src/llms/transformers/openai'
import { __setSurfacesForTests, invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests } from '../../src/services/router-preference-service'
import { __resetModelHealthForTest, recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { __resetSchedulerStateForTest } from '../../src/services/routing-scheduler/state'
import { profileWith } from '../llms/chain-fixture'

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
    if (inbound.tokenId !== undefined) c.set('accessToken', { id: inbound.tokenId, profileKey: null })
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
  return captured.value!
}

const asPlan = (result: RoutePlan | Response): RoutePlan => {
  if (result instanceof Response) throw new Error(`expected a plan, got ${result.status}`)
  return result
}

// Every surface passthrough: the router then returns before it can
// consult the chain, and body.model reaches the plan verbatim.
__setSurfacesForTests({})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

/**
 * On a routed surface the plan is the chain's answer. Three outcomes are
 * possible and each has to reach the /v1 handler in its own shape: a
 * primary with the rest of the chain behind it; no primary and the
 * caller's own model going out alone; or no primary and a 429 that never
 * dispatches at all.
 */
describe('a routed surface walks the chain', () => {
  const body = () => ({ model: 'caller,own', messages: [{ role: 'user', content: 'hi' }] })

  beforeEach(() => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed' })
    __resetSchedulerStateForTest()
    __resetModelHealthForTest()
  })

  afterEach(() => {
    __resetModelHealthForTest()
  })

  test('the plan carries the chain primary and the rest of the chain as fallbacks', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5', 'anthropic,claude-opus-4-7'] })
    })
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe('anthropic,claude-sonnet-5')
    expect(result.fallbacks).toEqual(['anthropic,claude-opus-4-7'])
    expect(result.routedBody.model).toBe('anthropic,claude-sonnet-5')
    // What the client asked for is still recorded next to what was sent.
    expect(result.requestedModel).toBe('caller,own')
  })

  test('no primary under exhaustedBehavior passthrough sends the caller’s own model with no fallbacks', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }, { exhaustedBehavior: 'passthrough' })
    })
    recordModelFailure('anthropic,claude-sonnet-5')
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe('caller,own')
    expect(result.fallbacks).toEqual([])
  })

  test('no primary under exhaustedBehavior 429 answers 429 with Retry-After and no plan', async () => {
    __setPreferencesForTests({
      live: profileWith({ 'default.agent': ['anthropic,claude-sonnet-5'] }, { exhaustedBehavior: '429' })
    })
    recordModelFailure('anthropic,claude-sonnet-5')
    const result = await plan('/v1/messages', body())
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.status).toBe(429)
    // No scheduler snapshot has published a reset yet, so the hint is
    // the default 30 s.
    expect(response.headers.get('Retry-After')).toBe('30')
    const envelope = (await response.json()) as { type?: string; error?: { type?: string } }
    expect(envelope.type).toBe('error')
    expect(envelope.error?.type).toBe('rate_limit_error')
  })

  test('an empty lane sends the caller’s own model even under exhaustedBehavior 429', async () => {
    __setPreferencesForTests({ live: profileWith({}, { exhaustedBehavior: '429' }) })
    const result = asPlan(await plan('/v1/messages', body()))
    expect(result.primaryModel).toBe('caller,own')
    expect(result.fallbacks).toEqual([])
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
})

describe('the body-carrying surfaces are untouched', () => {
  test('/v1/messages still reads its model from the body', async () => {
    const result = asPlan(await plan('/v1/messages', { model: 'anthropic,claude-sonnet-5', messages: [] }))
    expect(result.primaryModel).toBe('anthropic,claude-sonnet-5')
    expect(result.defaultTransformer.name).toBe('anthropic')
  })

  test('/v1/chat/completions keeps the stream flag the caller sent', async () => {
    const result = asPlan(await plan('/v1/chat/completions', { model: 'openai,gpt-5', stream: true, messages: [] }))
    expect(result.routedBody.stream).toBe(true)
    expect(result.defaultTransformer.name).toBe('openai')
  })

  test('a missing model on a body-carrying surface is still a 400', async () => {
    const result = await plan('/v1/messages', { messages: [] })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(400)
  })
})

describe('paths outside the registry', () => {
  test('404 in the caller-neutral Anthropic envelope, as before', async () => {
    const result = await plan('/v1/embeddings', { model: 'x' })
    expect(result).toBeInstanceOf(Response)
    const body = (await (result as Response).json()) as { type?: string }
    expect((result as Response).status).toBe(404)
    expect(body.type).toBe('error')
  })

  test('a gemini-shaped path with no action gets no model folded in', async () => {
    // `/v1beta/models/gemini-3-pro` has no `:action`, so there is nothing
    // to extract; the request fails on the missing model rather than on a
    // truncated one.
    const result = await plan('/v1beta/models/gemini-3-pro', {})
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(400)
  })
})

describe('the error envelope of a failed plan follows the surface', () => {
  test('a gemini 400 answers in google.rpc.Status shape', async () => {
    invalidateSurfaceCache()
    __setSurfacesForTests({})
    const result = await plan('/v1beta/models/gemini-3-pro', {})
    const body = (await (result as Response).json()) as { error?: { status?: string; code?: number } }
    expect(body.error?.status).toBe('INVALID_ARGUMENT')
    expect(body.error?.code).toBe(400)
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
        { model: 'anthropic,claude-sonnet-5', messages: [] },
        { headers: { 'x-claude-code-session-id': 'sess-1' }, tokenId: 'tok-1' }
      )
    )
    expect(result.accountSessionKey).toBe('sess-1')
  })

  test('falls back to the issued token when the client sends no session', async () => {
    const result = asPlan(
      await plan('/v1/chat/completions', { model: 'anthropic,claude-sonnet-5', messages: [] }, { tokenId: 'tok-1' })
    )
    expect(result.accountSessionKey).toBe('token:tok-1')
  })

  test('is stable across requests from the same token, so the pick sticks', async () => {
    const body = { model: 'anthropic,claude-sonnet-5', messages: [] }
    const first = asPlan(await plan('/v1/chat/completions', body, { tokenId: 'tok-1' }))
    const second = asPlan(await plan('/v1/chat/completions', body, { tokenId: 'tok-1' }))
    expect(second.accountSessionKey).toBe(first.accountSessionKey)
  })

  test('an unauthenticated-by-token call still gets a key rather than nothing', async () => {
    const result = asPlan(await plan('/v1/chat/completions', { model: 'anthropic,claude-sonnet-5', messages: [] }))
    expect(result.accountSessionKey).toBe('anonymous')
  })
})

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
 * asserted alongside. A token on a plan may only name the models its plan
 * lists: that check, and its 403, is asserted for every surface that
 * carries a model.
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
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { TokenPlan } from '../../src/services/access-token-service'
import { __setSurfacesForTests, invalidateSurfaceCache } from '../../src/services/inbound-surface-service'

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
  transformers.registerMany([
    new AnthropicTransformer(),
    new OpenAITransformer(),
    new OpenAIResponsesTransformer(),
    new GeminiTransformer()
  ])
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
  inbound: { headers?: Record<string, string>; tokenId?: string; plan?: TokenPlan } = {}
): Promise<RoutePlan | Response> {
  const ctx = await buildContext()
  const app = new Hono()
  const captured: { value: RoutePlan | Response | null } = { value: null }
  app.post('/*', async (c) => {
    // The /v1 auth middleware sets this when an issued token authenticated
    // the call; buildRoutePlan reads it back off the context.
    if (inbound.tokenId !== undefined)
      c.set('accessToken', {
        id: inbound.tokenId,
        name: 'test',
        surfaces: [],
        plan: inbound.plan === undefined ? null : inbound.plan
      })
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

const plan_ = (path: string, body: Record<string, unknown>, tokenPlan: TokenPlan) =>
  plan(path, body, { tokenId: 'tok-plan', plan: tokenPlan })

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
const LIMITS = { '5h': { requests: null, spendUsd: null }, '7d': { requests: null, spendUsd: null } }

// No surface denies a target unless a test says otherwise.
beforeEach(() => {
  __setSurfacesForTests({})
})

afterEach(() => {
  __setSurfacesForTests({})
})

describe('the gemini surface', () => {
  test('resolves its transformer through the surface endpoint, not the request path', async () => {
    const result = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect([...result.transformersByName.keys()]).toEqual(['gemini'])
    expect(result.defaultTransformer.name).toBe('gemini')
  })

  test('lands the path model on body.model, which is what every later stage reads', async () => {
    const result = asPlan(await plan('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }))
    expect(result.routedBody.model).toBe('google,gemini-3-pro')
    expect(result.primaryModel).toBe('google,gemini-3-pro')
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
    expect(result.primaryModel).toBe('google,gemini-3-pro')
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
 * A surface may refuse a target the operator switched off for it. The
 * check runs after the plan check, in the surface's own envelope.
 */
describe('denied targets', () => {
  test('bare and legacy qualified IDs keep the same tool-bearing request shape', async () => {
    const tools = [{ type: 'function', name: 'apply_patch', parameters: { type: 'object' } }]
    const body = { messages: [{ role: 'user', content: 'Edit this file' }], tools }
    const bare = asPlan(await plan('/v1/chat/completions', { ...body, model: 'claude-sonnet-5' }))
    const qualified = asPlan(await plan('/v1/chat/completions', { ...body, model: SONNET }))
    expect(bare.primaryModel).toBe(SONNET)
    expect(qualified.primaryModel).toBe(SONNET)
    expect(bare.routedBody.tools).toEqual(qualified.routedBody.tools)
    expect(bare.routedBody.messages).toEqual(qualified.routedBody.messages)
  })

  test('a denied target is a 400 that names it', async () => {
    __setSurfacesForTests({ 'anthropic-messages': [OPUS] })
    const response = asResponse(await plan('/v1/messages', { model: OPUS, messages: [] }))
    expect(response.status).toBe(400)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect(JSON.stringify(envelope)).toContain(`${OPUS} is turned off for /v1/messages`)
  })

  test('a target the list does not name goes through', async () => {
    __setSurfacesForTests({ 'anthropic-messages': [OPUS] })
    const result = asPlan(await plan('/v1/messages', { model: SONNET, messages: [] }))
    expect(result.primaryModel).toBe(SONNET)
  })

  test('the list is per surface: another surface may still name the target', async () => {
    __setSurfacesForTests({ 'anthropic-messages': [OPUS] })
    const result = asPlan(await plan('/v1/chat/completions', { model: OPUS, messages: [] }))
    expect(result.primaryModel).toBe(OPUS)
  })
})

/**
 * A token on a plan may only spend the plan's models. A listed model goes
 * through, naming none uses the plan's default, and naming any other model
 * is refused with 403 in the surface's own error shape rather than served
 * by a model the caller never asked for.
 */
describe('a token on a plan', () => {
  const tokenPlan: TokenPlan = { models: [SONNET, 'google,gemini-3-pro'], defaultModel: SONNET, limits: LIMITS }
  const prompt = [{ role: 'user', content: 'hi' }]

  test('keeps a listed model', async () => {
    const result = asPlan(await plan_('/v1/chat/completions', { model: SONNET, messages: prompt }, tokenPlan))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.route).toBe('passthrough')
    expect(result.fallbacks).toEqual([])
  })

  test('a bare name that exactly one listed model carries resolves to it', async () => {
    const result = asPlan(await plan_('/v1/messages', { model: 'claude-sonnet-5', messages: prompt }, tokenPlan))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.requestedModel).toBe('claude-sonnet-5')
  })

  test('a request naming no model goes to the plan’s default', async () => {
    const result = asPlan(await plan_('/v1/chat/completions', { messages: prompt }, tokenPlan))
    expect(result.primaryModel).toBe(SONNET)
    expect(result.routedBody.model).toBe(SONNET)
    expect(result.requestedModel).toBeUndefined()
  })

  test('/v1/messages refuses an unlisted model with 403 in the Anthropic envelope', async () => {
    const response = asResponse(await plan_('/v1/messages', { model: OPUS, messages: prompt }, tokenPlan))
    expect(response.status).toBe(403)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ type: 'error', error: { type: 'permission_error' } })
    expect(envelope).toMatchObject({
      error: {
        message: `Model "${OPUS}" is not allowed for this token. Allowed models: ${SONNET}, google,gemini-3-pro.`
      }
    })
  })

  test('/v1/chat/completions refuses an unlisted model with 403 in the OpenAI envelope', async () => {
    const response = asResponse(await plan_('/v1/chat/completions', { model: OPUS, messages: prompt }, tokenPlan))
    expect(response.status).toBe(403)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { type: 'permission_error' } })
    expect(envelope).not.toHaveProperty('type')
    expect(JSON.stringify(envelope)).toContain(OPUS)
  })

  test('/v1/responses refuses an unlisted model with 403 in the OpenAI envelope', async () => {
    const response = asResponse(await plan_('/v1/responses', { model: OPUS, input: 'hi' }, tokenPlan))
    expect(response.status).toBe(403)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { type: 'permission_error' } })
    expect(JSON.stringify(envelope)).toContain(OPUS)
  })

  test('gemini refuses an unlisted model named in the URL with 403 in google.rpc.Status shape', async () => {
    const response = asResponse(
      await plan_('/v1beta/models/gemini-3-flash:generateContent', { contents: [] }, tokenPlan)
    )
    expect(response.status).toBe(403)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ error: { status: 'PERMISSION_DENIED', code: 403 } })
    expect(JSON.stringify(envelope)).toContain('gemini-3-flash')
  })

  test('gemini keeps a listed model named in the URL', async () => {
    const result = asPlan(await plan_('/v1beta/models/gemini-3-pro:generateContent', { contents: [] }, tokenPlan))
    expect(result.primaryModel).toBe('google,gemini-3-pro')
  })

  test('a wrong provider prefix on a listed name is refused, not rewritten', async () => {
    const response = asResponse(
      await plan_('/v1/chat/completions', { model: 'google,claude-sonnet-5', messages: prompt }, tokenPlan)
    )
    expect(response.status).toBe(403)
  })

  test('a token with no plan is not checked', async () => {
    const result = asPlan(await plan('/v1/messages', { model: OPUS, messages: prompt }, { tokenId: 'tok-open' }))
    expect(result.primaryModel).toBe(OPUS)
  })
})

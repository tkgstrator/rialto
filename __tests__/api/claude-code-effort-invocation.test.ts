import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import pino from 'pino'
import { buildFailoverChain } from '../../src/api/v1/candidate-chain'
import { attemptChainEntry, type ChainCtx } from '../../src/api/v1/chain-failover'
import { resolveInvocationForModel } from '../../src/api/v1/invocation'
import { exhaustedChainResponse } from '../../src/api/v1/route'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import { sendToProvider } from '../../src/llms/pipeline/provider-send'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { CodexOauthTransformer, OpenAIResponsesTransformer } from '../../src/llms/transformers/openai'
import type { SupportedEffort } from '../../src/schemas/domain/model-capability'

const log = pino({ level: 'silent' })
const model = 'claude-sonnet-4-6'
// What each model's own list reported, as ModelCapability records it:
// Sonnet 4.6 has no xhigh, Haiku 4.5 takes no effort, and the third model
// has not been recorded yet.
const sonnet46: SupportedEffort[] = ['low', 'medium', 'high', 'max']
const providersConfig = [
  {
    name: 'claude-code',
    auth_mode: 'subscription' as const,
    api_style: 'anthropic' as const,
    api_key: 'fixture-placeholder',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: [model, 'claude-haiku-4-5', 'claude-unrecorded'],
    modelSupportedEfforts: { [model]: sonnet46, 'claude-haiku-4-5': [] }
  },
  {
    name: 'api-key',
    auth_mode: 'api_key' as const,
    api_style: 'anthropic' as const,
    api_key: 'fixture-key',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: [model]
  },
  {
    name: 'codex',
    auth_mode: 'subscription' as const,
    api_style: 'openai_responses' as const,
    api_key: 'fixture-placeholder',
    api_base_url: 'https://chatgpt.com/backend-api/codex',
    models: ['gpt-5.5']
  }
]
const endpoint = new AnthropicTransformer()
const oauth = new ClaudeCodeOauthTransformer()
const transformers = new TransformerRegistry(log)
transformers.registerMany([endpoint, oauth, new OpenAIResponsesTransformer(), new CodexOauthTransformer()])
const providers = new ProviderRegistry(transformers, log)
providers.registerFromConfig(providersConfig)
const ctx: LlmsContext = {
  config: new ConfigStore({ Providers: providersConfig, providers: providersConfig }),
  transformers,
  providers,
  tokenizers: new TokenizerRegistry(log),
  log
}

function plan(output: Record<string, unknown>): RoutePlan {
  return {
    routedBody: { model, messages: [], output_config: output },
    headers: {},
    transformersByName: new Map([
      ['anthropic', endpoint],
      ['claude-code-oauth', oauth]
    ]),
    defaultTransformer: endpoint,
    route: 'passthrough',
    primaryModel: `claude-code,${model}`,
    isSubagent: false,
    fallbacks: [],
    path: '/v1/messages',
    search: '',
    accountSessionKey: 'fixture-session'
  }
}

describe('Messages format and safeguards invocation', () => {
  test('Codex conversion receives the actual schema, without subscription-only effort', async () => {
    const schema = {
      type: 'object',
      properties: { permission: { type: 'string', enum: ['allow', 'deny'] } },
      required: ['permission'],
      additionalProperties: false
    }
    const input = plan({ effort: 'high', format: { type: 'json_schema', schema } })
    input.routedBody.max_tokens = 1024
    input.routedBody.stream = false
    input.routedBody.messages = [{ role: 'user', content: 'Assess permission.' }]
    const invocation = resolveInvocationForModel(input, 'codex,gpt-5.5', ctx)
    expect(invocation).not.toBeNull()
    if (invocation === null) throw new Error('Codex fixture provider is missing')
    expect(invocation.body.output_config).toEqual({ format: { type: 'json_schema', schema } })
    const unified = await invocation.transformer.transformRequestOut(invocation.body, {})
    expect(unified.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'anthropic_output', schema, strict: true }
    })
    expect(unified.stream).toBe(false)
    expect(input.routedBody.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema } })
  })

  test('legacy output_format and effort-only stripping retain the previous contract', () => {
    const input = plan({ effort: 'high' })
    input.routedBody.output_format = { type: 'json_schema', schema: { type: 'object' } }
    const invocation = resolveInvocationForModel(input, 'codex,gpt-5.5', ctx)
    expect(invocation?.body.output_config).toBeUndefined()
    expect(invocation?.body.output_format).toEqual(input.routedBody.output_format)
  })

  test('native Messages providers retain safeguards unchanged', () => {
    const input = plan({ effort: 'high' })
    input.routedBody.safeguards = { fixture: 'opaque native contract' }
    for (const name of ['claude-code', 'api-key']) {
      const invocation = resolveInvocationForModel(input, `${name},${model}`, ctx)
      expect(invocation?.body.safeguards).toEqual(input.routedBody.safeguards)
    }
  })

  test('Codex skips even empty or null safeguards instead of silently dropping permission semantics', () => {
    for (const safeguards of [{}, null, { fixture: 'opaque native contract' }]) {
      const input = plan({ effort: 'high' })
      input.routedBody.safeguards = safeguards
      expect(resolveInvocationForModel(input, 'codex,gpt-5.5', ctx)).toBeNull()
      expect(input.routedBody.safeguards).toEqual(safeguards)
    }
  })

  test('only the operator-configured native fallback is attempted after an incompatible primary', async () => {
    const input = plan({ effort: 'high' })
    input.routedBody.safeguards = { fixture: 'opaque native contract' }
    input.primaryModel = 'codex,gpt-5.5'
    input.fallbacks = [`api-key,${model}`]
    const attempted: string[] = []
    const app = new Hono()
    app.post('/v1/messages', async (c) => {
      const chain: ChainCtx = {
        c,
        ctx,
        plan: input,
        providers: [],
        sessionId: input.accountSessionKey,
        attempt: async (invocation) => {
          attempted.push(invocation.provider.name)
          expect(invocation.body.safeguards).toEqual(input.routedBody.safeguards)
          return c.json({ fixture: 'native result' })
        },
        errorResponse: () => new Response('unexpected error', { status: 500 })
      }
      for (const candidate of buildFailoverChain(input)) {
        const outcome = await attemptChainEntry(chain, candidate)
        if (outcome.kind === 'done') return outcome.response
      }
      return exhaustedChainResponse(c, input, null)
    })
    const response = await app.request('/v1/messages', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(attempted).toEqual(['api-key'])
  })

  test('a chain without a native target fails closed without selecting another registered provider', async () => {
    const input = plan({ effort: 'high' })
    input.routedBody.safeguards = {}
    input.primaryModel = 'codex,gpt-5.5'
    const attempted: string[] = []
    const app = new Hono()
    app.post('/v1/messages', async (c) => {
      const chain: ChainCtx = {
        c,
        ctx,
        plan: input,
        providers: [],
        sessionId: input.accountSessionKey,
        attempt: async (invocation) => {
          attempted.push(invocation.provider.name)
          return new Response('unexpected dispatch')
        },
        errorResponse: () => new Response('unexpected error', { status: 500 })
      }
      for (const candidate of buildFailoverChain(input)) {
        const outcome = await attemptChainEntry(chain, candidate)
        if (outcome.kind === 'done') return outcome.response
      }
      return exhaustedChainResponse(c, input, null)
    })
    const response = await app.request('/v1/messages', { method: 'POST' })
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error.message', expect.stringContaining('Anthropic safeguards'))
    expect(attempted).toEqual([])
  })

  test('native upstream refusal is preserved ahead of the final compatibility error', async () => {
    const input = plan({ effort: 'high' })
    input.routedBody.safeguards = {}
    const refusal = new Response('native rate limit', { status: 429, headers: { 'retry-after': '60' } })
    const app = new Hono()
    app.post('/v1/messages', (c) => exhaustedChainResponse(c, input, refusal))
    const response = await app.request('/v1/messages', { method: 'POST' })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await response.text()).toBe('native rate limit')
  })

  test('a suspected permission classifier without explicit safeguards is not blocked', () => {
    const input = plan({ effort: 'high' })
    input.routedBody.messages = [{ role: 'user', content: 'Assess permission for this tool call.' }]
    input.classifierSignals = { safeguardsPresent: false, suspectedClassifier: true }
    expect(resolveInvocationForModel(input, 'codex,gpt-5.5', ctx)).not.toBeNull()
  })
})

describe('Claude Code per-attempt invocation', () => {
  test('keeps selector identity and request correlation through failover sends', async () => {
    const input: RoutePlan = {
      ...plan({}),
      reqId: 'inbound-request',
      selectedRoutes: [
        { target: `claude-code,${model}`, targetTier: 'opus', route: 'claude-code · opus' },
        { target: `claude-code,${model}`, targetTier: 'sonnet', route: 'claude-code · sonnet' },
        { target: `api-key,${model}`, targetTier: 'haiku', route: 'api-key · haiku' }
      ]
    }
    const primary = resolveInvocationForModel(input, `claude-code,${model}`, ctx)
    const fallback = resolveInvocationForModel(input, `api-key,${model}`, ctx)
    if (primary === null || fallback === null) throw new Error('fixture must resolve')
    expect(primary.request.selectedTier).toBe('opus')
    expect(fallback.request.selectedTier).toBe('haiku')
    const entries: Record<string, unknown>[] = []
    const capture = pino({}, { write: (line: string) => entries.push(JSON.parse(line)) })
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response('private-error', { status: 429 })
      await expect(
        sendToProvider(
          { ...primary.body, model: 'transformed-model' },
          {},
          primary.provider,
          primary.transformer,
          false,
          { req: primary.request },
          { log: capture }
        )
      ).rejects.toThrow()
      globalThis.fetch = async () => new Response('{}', { status: 200 })
      await sendToProvider(
        fallback.body,
        {},
        fallback.provider,
        fallback.transformer,
        false,
        { req: fallback.request },
        { log: capture }
      )
      const observations = entries.filter((entry) => entry.event === 'routing_upstream')
      expect(observations.map((entry) => entry.outcome)).toEqual(['send', 'failure', 'send', 'success'])
      expect(observations.map((entry) => entry.reqId)).toEqual(Array(4).fill('inbound-request'))
      expect(observations[0]?.attemptId).toBe(observations[1]?.attemptId)
      expect(observations[2]?.attemptId).toBe(observations[3]?.attemptId)
      expect(observations[0]?.attemptId).not.toBe(observations[2]?.attemptId)
      expect(observations[1]).toMatchObject({
        provider: 'claude-code',
        model: 'transformed-model',
        selectedTier: 'opus',
        status: 429
      })
      expect(observations[3]).toMatchObject({
        provider: 'api-key',
        model,
        selectedTier: 'haiku',
        status: 200,
        expectedTier: null,
        evaluationStatus: 'unrated'
      })
      expect(JSON.stringify(observations)).not.toContain('private-error')
      expect(JSON.stringify(observations)).not.toContain('fixture-key')
      expect(JSON.stringify(observations)).not.toContain('https://')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
  test('reports network failure without error details or inventing a passthrough tier', async () => {
    const invocation = resolveInvocationForModel({ ...plan({}), reqId: 'network-request' }, `api-key,${model}`, ctx)
    if (invocation === null) throw new Error('fixture must resolve')
    const entries: Record<string, unknown>[] = []
    const capture = pino({}, { write: (line: string) => entries.push(JSON.parse(line)) })
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => {
        throw new Error('private-network-error')
      }
      await expect(
        sendToProvider(
          invocation.body,
          {},
          invocation.provider,
          invocation.transformer,
          false,
          { req: invocation.request },
          { log: capture }
        )
      ).rejects.toThrow('private-network-error')
      const observations = entries.filter((entry) => entry.event === 'routing_upstream')
      expect(observations.map((entry) => entry.outcome)).toEqual(['send', 'failure'])
      expect(observations[1]).toMatchObject({
        reqId: 'network-request',
        reason: 'network_error',
        status: null,
        selectedTier: null,
        selectedRoute: null
      })
      expect(observations[0]?.attemptId).toBe(observations[1]?.attemptId)
      expect(JSON.stringify(observations)).not.toContain('private-network-error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('retains native output_config and clamps only a documented unsupported level on a copy', () => {
    const input = plan({ effort: 'xhigh', format: { type: 'json_schema' } })
    const claude = resolveInvocationForModel(input, `claude-code,${model}`, ctx)
    expect(claude?.body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema' } })
    expect(claude?.request.clientEffortIntent).toBe('explicit')
    expect(input.routedBody.output_config).toEqual({ effort: 'xhigh', format: { type: 'json_schema' } })
    const fallback = resolveInvocationForModel(input, `api-key,${model}`, ctx)
    expect(fallback?.body.output_config).toEqual({ format: { type: 'json_schema' } })
    expect(input.routedBody.output_config).toEqual({ effort: 'xhigh', format: { type: 'json_schema' } })
  })

  test('drops the effort of a model whose list reports no level at all', () => {
    const input = plan({ effort: 'high', format: { type: 'json_schema' } })
    const haiku = resolveInvocationForModel(input, 'claude-code,claude-haiku-4-5', ctx)
    expect(haiku?.body.output_config).toEqual({ format: { type: 'json_schema' } })
  })

  test('sends the effort of a model not yet recorded as the caller wrote it', () => {
    const input = plan({ effort: 'xhigh' })
    const unrecorded = resolveInvocationForModel(input, 'claude-code,claude-unrecorded', ctx)
    expect(unrecorded?.body.output_config).toEqual({ effort: 'xhigh' })
  })

  test('keeps unverified effort untouched rather than inventing a different value', () => {
    for (const effort of ['novel', 'minimal', 'none']) {
      const input = plan({ effort })
      expect(resolveInvocationForModel(input, `claude-code,${model}`, ctx)?.body.output_config).toEqual({ effort })
      expect(input.routedBody.output_config).toEqual({ effort })
    }
  })
})

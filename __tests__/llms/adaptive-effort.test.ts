import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { applyAdaptiveEffort, applyBypassManualEffort } from '../../src/llms/pipeline/adaptive-effort'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { OpenAITransformer } from '../../src/llms/transformers/openai/endpoint-chat'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai/endpoint-responses'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'

const model = 'gpt-5.4'
const log = pino({ level: 'silent' })
const transformers = new TransformerRegistry(log)
transformers.registerMany([new OpenAITransformer(), new OpenAIResponsesTransformer()])
const providers = new ProviderRegistry(transformers, log)
providers.registerFromConfig([
  {
    name: 'openai',
    api_style: 'openai_chat',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/chat/completions',
    api_key: 'fixture-key',
    models: [model],
    modelReasoningEfforts: { [model]: 'auto' }
  },
  {
    name: 'manual',
    api_style: 'openai_chat',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/chat/completions',
    api_key: 'fixture-key',
    models: [model],
    modelReasoningEfforts: { [model]: 'high' }
  },
  {
    name: 'responses',
    api_style: 'openai_responses',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/responses',
    api_key: 'fixture-key',
    models: [model],
    modelReasoningEfforts: { [model]: 'auto' }
  },
  {
    name: 'codex',
    api_style: 'openai_responses',
    auth_mode: 'subscription',
    api_base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: 'fixture-subscription-placeholder',
    models: [model],
    modelReasoningEfforts: { [model]: 'auto' },
    // What the model's Codex list reported, recorded once (ModelCapability).
    modelSupportedEfforts: { [model]: ['low', 'high'] }
  },
  {
    name: 'codex-unrecorded',
    api_style: 'openai_responses',
    auth_mode: 'subscription',
    api_base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: 'fixture-subscription-placeholder',
    models: [model],
    modelReasoningEfforts: { [model]: 'auto' }
  }
])

function publish(provider: string, projectedPct: number, tickAt = Date.now()) {
  publishSnapshot({
    tickAt,
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map([
      [
        `${provider},${model}`,
        { target: `${provider},${model}`, exhausted: false, remainingBudgetPct: 60, projectedPct, resetAt: null }
      ]
    ]),
    accounts: [],
    soonestResetAt: null
  })
}

function apply(providerName: string, body: Record<string, unknown>, explicit = false) {
  const provider = providers.get(providerName)
  if (provider === undefined) throw new Error('Fixture provider missing')
  return applyAdaptiveEffort(body, provider, {
    req: {
      body,
      model,
      headers: {},
      url: '/v1/chat/completions',
      clientEffortIntent: explicit ? 'explicit' : 'unspecified'
    }
  })
}

afterEach(() => __resetSchedulerStateForTest())

describe('adaptive outbound effort', () => {
  test('fills Chat bypass wire shape only with fresh verified quota', () => {
    publish('openai', 40)
    const body = { model, messages: [] }
    expect(apply('openai', body)?.effort).toBe('high')
    expect(body).toEqual({ model, messages: [], reasoning_effort: 'high' })
    publish('openai', 40, Date.now() - 16 * 60_000)
    expect(apply('openai', { model })).toBeNull()
  })

  test('fills Responses shape and preserves existing reasoning fields', () => {
    publish('responses', 110)
    const body = { model, reasoning: { summary: 'auto' } }
    expect(apply('responses', body)?.effort).toBe('low')
    expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto' })
  })

  test('respects explicit client effort even if conversion removed its wire field', () => {
    publish('responses', 40)
    const body = { model }
    expect(apply('responses', body, true)).toBeNull()
    expect(body).toEqual({ model })
  })

  test('does not carry an adaptive decision into another fallback attempt', () => {
    publish('openai', 40)
    const inbound = { model, messages: [] }
    const first = { ...inbound }
    expect(apply('openai', first)?.effort).toBe('high')
    expect(inbound).toEqual({ model, messages: [] })
    publish('responses', 120)
    const second = { ...inbound }
    expect(apply('responses', second)?.effort).toBe('low')
    expect(second).toEqual({ model, messages: [], reasoning: { effort: 'low', summary: 'detailed' } })
    expect(inbound).toEqual({ model, messages: [] })
  })

  test('ignores degraded, exhausted, missing, and invalid target readings', () => {
    publish('openai', 40)
    expect(apply('responses', { model })).toBeNull()
    publish('openai', Number.NaN)
    expect(apply('openai', { model })).toBeNull()
    publishSnapshot({
      tickAt: Date.now(),
      tickCount: 1,
      consecutiveFailures: 1,
      degraded: true,
      targets: new Map([
        [
          `openai,${model}`,
          { target: `openai,${model}`, exhausted: true, remainingBudgetPct: 0, projectedPct: 40, resetAt: null }
        ]
      ]),
      accounts: [],
      soonestResetAt: null
    })
    expect(apply('openai', { model })).toBeNull()
  })

  test('honors Anthropic thinking and output effort intent across conversion', () => {
    publish('responses', 40)
    const provider = providers.get('responses')
    if (provider === undefined) throw new Error('Fixture provider missing')
    for (const input of [
      { thinking: { type: 'disabled' } },
      { thinking: { budget_tokens: 2048 } },
      { output_config: { effort: 'high' } },
      { reasoning: { effort: 'none' } }
    ]) {
      const outbound = { model }
      expect(
        applyAdaptiveEffort(outbound, provider, {
          req: { body: { model, ...input }, model, headers: {}, url: '/v1/messages' }
        })
      ).toBeNull()
      expect(outbound).toEqual({ model })
    }
  })

  test('chooses among the levels the Codex model recorded, and leaves an unrecorded one alone', () => {
    const recorded = providers.get('codex')
    const unrecorded = providers.get('codex-unrecorded')
    if (recorded === undefined || unrecorded === undefined) throw new Error('Fixture provider missing')
    publish('codex', 40)
    const request = { req: { body: { model }, model, headers: {}, url: '/v1/responses' } }
    const outbound = { model }
    expect(applyAdaptiveEffort(outbound, recorded, request)?.effort).toBe('high')
    expect(outbound).toEqual({ model, reasoning: { effort: 'high', summary: 'detailed' } })
    const untouched = { model }
    expect(applyAdaptiveEffort(untouched, unrecorded, request)).toBeNull()
    expect(untouched).toEqual({ model })
  })

  test('manual effort wins over caller effort on the Chat bypass path', () => {
    const provider = providers.get('manual')
    if (provider === undefined) throw new Error('Fixture provider missing')
    const body = { model, reasoning_effort: 'low' }
    applyBypassManualEffort(body, provider, {
      req: { body, model, headers: {}, url: '/v1/chat/completions' }
    })
    expect(body.reasoning_effort).toBe('high')
    expect(
      applyAdaptiveEffort(body, provider, { req: { body, model, headers: {}, url: '/v1/chat/completions' } })
    ).toBeNull()
  })

  test('leaves existing outbound effort and missing readings untouched', () => {
    publish('openai', 40)
    const body = { model, reasoning_effort: 'none' }
    expect(apply('openai', body)).toBeNull()
    expect(body.reasoning_effort).toBe('none')
    __resetSchedulerStateForTest()
    expect(apply('openai', { model })).toBeNull()
  })
})

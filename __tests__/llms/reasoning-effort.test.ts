/**
 * The reasoning effort a request log row records.
 *
 * The column answers "what was the vendor told", so it is read from the
 * body that is actually dispatched. The cases that matter are the ones
 * where that differs from the inbound request: Auto fills a level in, and
 * a manual setting replaces the one the client sent.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { applyAdaptiveEffort, applyBypassManualEffort } from '../../src/llms/pipeline/adaptive-effort'
import { sentReasoningEffort } from '../../src/llms/pipeline/reasoning-effort'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { OpenAITransformer } from '../../src/llms/transformers/openai/endpoint-chat'
import { OpenAIResponsesTransformer } from '../../src/llms/transformers/openai/endpoint-responses'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'

describe('sentReasoningEffort', () => {
  test('reads the Anthropic place: output_config.effort', () => {
    expect(sentReasoningEffort({ model: 'm', output_config: { effort: 'high' } })).toBe('high')
  })

  test('reads the Chat Completions place: reasoning_effort', () => {
    expect(sentReasoningEffort({ model: 'm', reasoning_effort: 'low' })).toBe('low')
  })

  test('reads the Responses / Codex place: reasoning.effort', () => {
    expect(sentReasoningEffort({ model: 'm', reasoning: { effort: 'xhigh', summary: 'detailed' } })).toBe('xhigh')
  })

  test('records a level this build has no name for, as the vendor spelled it', () => {
    // The column is free text so a new rung is still recorded.
    expect(sentReasoningEffort({ reasoning_effort: 'ludicrous' })).toBe('ludicrous')
  })

  test('a body that sets none is null', () => {
    expect(sentReasoningEffort({ model: 'm', messages: [] })).toBeNull()
    expect(sentReasoningEffort({ reasoning: { summary: 'auto' } })).toBeNull()
    expect(sentReasoningEffort({ output_config: {} })).toBeNull()
  })

  test('an empty string is not a level', () => {
    expect(sentReasoningEffort({ reasoning_effort: '' })).toBeNull()
    expect(sentReasoningEffort({ output_config: { effort: '' } })).toBeNull()
    expect(sentReasoningEffort({ reasoning: { effort: '' } })).toBeNull()
  })

  test('a value that is not a string is ignored', () => {
    expect(sentReasoningEffort({ reasoning_effort: 3 })).toBeNull()
    expect(sentReasoningEffort({ reasoning_effort: null })).toBeNull()
    expect(sentReasoningEffort({ output_config: { effort: { level: 'high' } } })).toBeNull()
    expect(sentReasoningEffort({ reasoning: { effort: ['high'] } })).toBeNull()
  })

  test('a malformed container is ignored rather than thrown on', () => {
    expect(sentReasoningEffort({ output_config: 'high' })).toBeNull()
    expect(sentReasoningEffort({ reasoning: 'high' })).toBeNull()
    expect(sentReasoningEffort({ output_config: null, reasoning: null })).toBeNull()
  })

  test('a body that is not an object is null', () => {
    expect(sentReasoningEffort(null)).toBeNull()
    expect(sentReasoningEffort(undefined)).toBeNull()
    expect(sentReasoningEffort('high')).toBeNull()
    expect(sentReasoningEffort(['high'])).toBeNull()
  })

  test('an unusable first place does not hide a usable later one', () => {
    expect(sentReasoningEffort({ output_config: { effort: '' }, reasoning_effort: 'medium' })).toBe('medium')
  })
})

// ─── Through the same overrides provider-send.ts applies ─────────────

const log = pino({ level: 'silent' })
const transformers = new TransformerRegistry(log)
transformers.registerMany([new ClaudeCodeOauthTransformer(), new OpenAITransformer(), new OpenAIResponsesTransformer()])
const providers = new ProviderRegistry(transformers, log)

const gpt = 'gpt-5.4'
const claude = 'claude-sonnet-5'
providers.registerFromConfig([
  {
    name: 'openai-auto',
    api_style: 'openai_chat',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/chat/completions',
    api_key: 'fixture-key',
    models: [gpt],
    modelReasoningEfforts: { [gpt]: 'auto' }
  },
  {
    name: 'responses-auto',
    api_style: 'openai_responses',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/responses',
    api_key: 'fixture-key',
    models: [gpt],
    modelReasoningEfforts: { [gpt]: 'auto' }
  },
  {
    name: 'responses-manual',
    api_style: 'openai_responses',
    auth_mode: 'api_key',
    api_base_url: 'https://api.openai.com/v1/responses',
    api_key: 'fixture-key',
    models: [gpt],
    modelReasoningEfforts: { [gpt]: 'high' }
  },
  {
    name: 'claude-code',
    api_style: 'anthropic',
    auth_mode: 'subscription',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: 'fixture-placeholder',
    models: [claude],
    modelReasoningEfforts: { [claude]: 'auto' },
    modelSupportedEfforts: { [claude]: ['low', 'medium', 'high', 'xhigh', 'max'] }
  }
])

const provider = (name: string) => {
  const resolved = providers.get(name)
  if (resolved === undefined) throw new Error('Fixture provider missing')
  return resolved
}

const publish = (target: string, projectedPct: number) =>
  publishSnapshot({
    tickAt: Date.now(),
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map([[target, { target, exhausted: false, remainingBudgetPct: 60, projectedPct, resetAt: null }]]),
    accounts: [],
    soonestResetAt: null
  })

const contextFor = (model: string, body: Record<string, unknown>) => ({
  req: { body, model, headers: {}, url: '/v1/messages', clientEffortIntent: 'unspecified' as const }
})

afterEach(() => __resetSchedulerStateForTest())

describe('the effort of a body Rialto has rewritten', () => {
  test('Auto on a Chat upstream: the level it inserted is the level recorded', () => {
    publish(`openai-auto,${gpt}`, 40)
    const body: Record<string, unknown> = { model: gpt, messages: [] }
    expect(sentReasoningEffort(body)).toBeNull()
    applyAdaptiveEffort(body, provider('openai-auto'), contextFor(gpt, body))
    expect(sentReasoningEffort(body)).toBe('high')
  })

  test('Auto on a Responses upstream: reasoning.effort is recorded', () => {
    publish(`responses-auto,${gpt}`, 110)
    const body: Record<string, unknown> = { model: gpt, reasoning: { summary: 'auto' } }
    applyAdaptiveEffort(body, provider('responses-auto'), contextFor(gpt, body))
    expect(sentReasoningEffort(body)).toBe('low')
  })

  test('Auto on an Anthropic upstream: output_config.effort is recorded', () => {
    publish(`claude-code,${claude}`, 80)
    const body: Record<string, unknown> = { model: claude, messages: [] }
    applyAdaptiveEffort(body, provider('claude-code'), contextFor(claude, body))
    expect(sentReasoningEffort(body)).toBe('medium')
  })

  test('a manual setting replaces what the client sent, and the replacement is what is recorded', () => {
    const body: Record<string, unknown> = { model: gpt, reasoning: { effort: 'low' } }
    expect(sentReasoningEffort(body)).toBe('low')
    applyBypassManualEffort(body, provider('responses-manual'), contextFor(gpt, body))
    expect(sentReasoningEffort(body)).toBe('high')
  })

  test('Auto that finds no fresh quota leaves nothing to record', () => {
    const body: Record<string, unknown> = { model: gpt, messages: [] }
    expect(applyAdaptiveEffort(body, provider('openai-auto'), contextFor(gpt, body))).toBeNull()
    expect(sentReasoningEffort(body)).toBeNull()
  })
})

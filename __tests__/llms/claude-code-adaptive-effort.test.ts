import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { applyAdaptiveEffort, applyBypassManualEffort } from '../../src/llms/pipeline/adaptive-effort'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'
import { claudeCodeEffortsFor } from '../../src/shared/model-reasoning-effort'

const model = 'claude-sonnet-5'
const log = pino({ level: 'silent' })
const transformers = new TransformerRegistry(log)
transformers.registerMany([new ClaudeCodeOauthTransformer()])
const providers = new ProviderRegistry(transformers, log)
providers.registerFromConfig([
  {
    name: 'claude-code',
    api_style: 'anthropic',
    auth_mode: 'subscription',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: 'fixture-placeholder',
    models: [model, 'claude-haiku-4-5'],
    modelReasoningEfforts: { [model]: 'auto' }
  },
  {
    name: 'claude-manual',
    api_style: 'anthropic',
    auth_mode: 'subscription',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: 'fixture-placeholder',
    models: [model, 'claude-haiku-4-5'],
    modelReasoningEfforts: { [model]: 'high', 'claude-haiku-4-5': 'high' }
  }
])

function provider(name: string) {
  const resolved = providers.get(name)
  if (resolved === undefined) throw new Error('Missing fixture provider')
  return resolved
}

function publish(projectedPct: number, tickAt = Date.now()) {
  publishSnapshot({
    tickAt,
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map([
      [
        `claude-code,${model}`,
        { target: `claude-code,${model}`, exhausted: false, remainingBudgetPct: 60, projectedPct, resetAt: null }
      ]
    ]),
    accounts: [],
    soonestResetAt: null
  })
}

function apply(body: Record<string, unknown>, inbound = body, intent?: 'explicit' | 'unspecified') {
  return applyAdaptiveEffort(body, provider('claude-code'), {
    req: {
      body: inbound,
      model,
      headers: {},
      url: '/v1/messages',
      clientEffortIntent: intent,
      subAccountId: 'chosen-account'
    }
  })
}

afterEach(() => __resetSchedulerStateForTest())

describe('Claude Code effort capabilities and outbound shaping', () => {
  test('uses documented Claude Code IDs and does not infer unlisted variants', () => {
    expect(claudeCodeEffortsFor('claude-fable-5-1')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claudeCodeEffortsFor('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(claudeCodeEffortsFor('claude-sonnet-4-6')).not.toContain('xhigh')
    for (const id of ['claude-haiku-4-5', 'claude-mythos-5', 'claude-opus-4-5', 'claude-sonnet-5-20260901']) {
      expect(claudeCodeEffortsFor(id)).toBeNull()
    }
  })

  test('writes native output_config effort at each fresh quota pace', () => {
    for (const [pace, effort] of [
      [59, 'high'],
      [60, 'medium'],
      [100, 'medium'],
      [101, 'low']
    ] as const) {
      publish(pace)
      const body = { model, output_config: { format: { type: 'json_schema' } } }
      expect(apply(body)?.effort).toBe(effort)
      expect(body.output_config).toEqual({ format: { type: 'json_schema' }, effort })
      expect(body).not.toHaveProperty('reasoning')
      expect(body).not.toHaveProperty('reasoning_effort')
    }
  })

  test('leaves explicit effort and thinking controls untouched', () => {
    publish(40)
    for (const inbound of [
      { output_config: { effort: 'max' } },
      { thinking: { type: 'disabled' } },
      { thinking: { type: 'enabled', budget_tokens: 4096 } },
      { reasoning: { effort: 'low' } }
    ]) {
      const outbound = { model, output_config: { format: 'json' } }
      expect(apply(outbound, { model, ...inbound }, 'explicit')).toBeNull()
      expect(outbound).toEqual({ model, output_config: { format: 'json' } })
    }
  })

  test('manual override wins without emitting unsupported Claude levels', () => {
    const body = { model, output_config: { effort: 'low', format: 'json' } }
    applyBypassManualEffort(body, provider('claude-manual'), {
      req: { body, model, headers: {}, url: '/v1/messages' }
    })
    expect(body.output_config).toEqual({ effort: 'high', format: 'json' })
    const unknown = { model: 'claude-haiku-4-5' }
    applyBypassManualEffort(unknown, provider('claude-manual'), {
      req: { body: unknown, model: 'claude-haiku-4-5', headers: {}, url: '/v1/messages' }
    })
    expect(unknown).toEqual({ model: 'claude-haiku-4-5' })
  })

  test('ignores missing or stale quota and preserves the original request for a later attempt', () => {
    const original = { model, output_config: { format: 'json' } }
    expect(apply({ ...original })).toBeNull()
    publish(40, Date.now() - 16 * 60_000)
    expect(apply({ ...original })).toBeNull()
    publish(120)
    const attempt = { ...original }
    expect(apply(attempt)?.effort).toBe('low')
    expect(original).toEqual({ model, output_config: { format: 'json' } })
  })
})

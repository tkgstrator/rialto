import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { resolveInvocationForModel } from '../../src/api/v1/invocation'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
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
  }
]
const endpoint = new AnthropicTransformer()
const oauth = new ClaudeCodeOauthTransformer()
const transformers = new TransformerRegistry(log)
transformers.registerMany([endpoint, oauth])
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

describe('Claude Code per-attempt invocation', () => {
  test('retains native output_config and clamps only a documented unsupported level on a copy', () => {
    const input = plan({ effort: 'xhigh', format: { type: 'json_schema' } })
    const claude = resolveInvocationForModel(input, `claude-code,${model}`, ctx)
    expect(claude?.body.output_config).toEqual({ effort: 'high', format: { type: 'json_schema' } })
    expect(claude?.request.clientEffortIntent).toBe('explicit')
    expect(input.routedBody.output_config).toEqual({ effort: 'xhigh', format: { type: 'json_schema' } })
    const fallback = resolveInvocationForModel(input, `api-key,${model}`, ctx)
    expect(fallback?.body.output_config).toBeUndefined()
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

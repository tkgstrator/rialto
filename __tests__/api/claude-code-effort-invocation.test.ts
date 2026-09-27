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

const log = pino({ level: 'silent' })
const model = 'claude-sonnet-4-6'
const providersConfig = [
  {
    name: 'claude-code',
    auth_mode: 'subscription' as const,
    api_style: 'anthropic' as const,
    api_key: 'fixture-placeholder',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: [model]
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

  test('keeps unverified effort untouched rather than inventing a different value', () => {
    for (const effort of ['novel', 'minimal', 'none']) {
      const input = plan({ effort })
      expect(resolveInvocationForModel(input, `claude-code,${model}`, ctx)?.body.output_config).toEqual({ effort })
      expect(input.routedBody.output_config).toEqual({ effort })
    }
  })
})

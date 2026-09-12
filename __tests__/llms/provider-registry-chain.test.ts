/**
 * The registry end of the derivation.
 *
 * `shared/transformer-chain.test.ts` pins the mapping; this pins the part
 * that used to be a config read — that the registry builds the chain
 * itself, resolves it to real Transformer instances in run order, and
 * refuses to register a provider it cannot build one for.
 */
import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import {
  CodexOauthTransformer,
  OpenAIResponsesTransformer,
  OpenAITransformer
} from '../../src/llms/transformers/openai'
import type { ProviderConfigShape } from '../../src/schemas/domain/pipeline'

const log = pino({ level: 'silent' })

const registryWith = (providers: ProviderConfigShape[]): ProviderRegistry => {
  const transformers = new TransformerRegistry(log)
  transformers.registerMany([
    new AnthropicTransformer(),
    new OpenAITransformer(),
    new OpenAIResponsesTransformer(),
    new GeminiTransformer(),
    new ClaudeCodeOauthTransformer(),
    new CodexOauthTransformer()
  ])
  const registry = new ProviderRegistry(transformers, log)
  registry.registerFromConfig(providers)
  return registry
}

const chainNames = (registry: ProviderRegistry, name: string): string[] | undefined => {
  const use = registry.get(name)?.transformer?.use
  return use === undefined ? undefined : use.map((t) => t.name)
}

const base = {
  api_key: 'sk-test',
  auth_mode: 'api_key',
  models: []
} satisfies Partial<ProviderConfigShape>

describe('ProviderRegistry chain derivation', () => {
  test('builds the chain from api_style with nothing in the config saying so', () => {
    const registry = registryWith([
      { ...base, name: 'openai', api_style: 'openai_chat', api_base_url: 'https://api.openai.com/v1/chat/completions' }
    ])
    expect(chainNames(registry, 'openai')).toEqual(['openai'])
  })

  test('a stale `use` left in the config is ignored, not honoured', () => {
    // A row seeded by an older build can still carry one. The registry
    // takes api_style as the only answer.
    const registry = registryWith([
      {
        ...base,
        name: 'google',
        api_style: 'gemini',
        api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
        transformer: { use: ['openai'] }
      }
    ])
    expect(chainNames(registry, 'google')).toEqual(['gemini'])
  })

  test('an anthropic api_key provider registers its native endpoint transformer', () => {
    const registry = registryWith([
      { ...base, name: 'anthropic', api_style: 'anthropic', api_base_url: 'https://api.anthropic.com/v1/messages' }
    ])
    expect(registry.get('anthropic')).toBeDefined()
    expect(chainNames(registry, 'anthropic')).toEqual(['anthropic'])
  })

  test('a stale `use` cannot replace the native Anthropic endpoint step', () => {
    // The derived chain contains real Transformer instances, not legacy
    // configuration strings, while unrelated credential metadata survives.
    const registry = registryWith([
      {
        ...base,
        name: 'anthropic',
        api_style: 'anthropic',
        api_base_url: 'https://api.anthropic.com/v1/messages',
        transformer: { use: ['openai'], subscriptionCredentialPath: '/creds/x.json' }
      }
    ])
    expect(chainNames(registry, 'anthropic')).toEqual(['anthropic'])
    expect(registry.get('anthropic')?.transformer?.subscriptionCredentialPath).toBe('/creds/x.json')
  })

  test('a codex-family model on the openai provider gets its own chain after the provider one', () => {
    const registry = registryWith([
      {
        ...base,
        name: 'openai',
        api_style: 'openai_chat',
        api_base_url: 'https://api.openai.com/v1/chat/completions',
        models: ['gpt-5', 'gpt-5-codex'],
        modelApiStyles: { 'gpt-5-codex': 'openai_responses' }
      }
    ])
    expect(chainNames(registry, 'openai')).toEqual(['openai'])
    const perModel = registry.get('openai')?.transformer?.['gpt-5-codex']
    expect(perModel).toEqual({ use: [expect.objectContaining({ name: 'openai-responses' })] })
    expect(registry.get('openai')?.transformer?.['gpt-5']).toBeUndefined()
  })

  test('the subscription credential survives alongside the derived chain', () => {
    const registry = registryWith([
      {
        ...base,
        name: 'codex',
        auth_mode: 'subscription',
        api_style: 'openai_responses',
        api_base_url: 'https://chatgpt.com/backend-api/codex',
        api_key: 'oauth',
        transformer: { subscriptionCredentialPath: '/creds/codex.json' }
      }
    ])
    expect(chainNames(registry, 'codex')).toEqual(['openai-responses', 'codex-oauth'])
    expect(registry.get('codex')?.transformer?.subscriptionCredentialPath).toBe('/creds/codex.json')
  })

  test('a subscription vendor with no auth transformer is left unregistered', () => {
    // Registering it would mean calling the upstream with the placeholder
    // key the overlay hands out.
    const registry = registryWith([
      {
        ...base,
        name: 'gemini-cli',
        auth_mode: 'subscription',
        api_style: 'gemini',
        api_base_url: 'https://cloudcode-pa.googleapis.com/v1internal',
        api_key: 'oauth'
      }
    ])
    expect(registry.get('gemini-cli')).toBeUndefined()
  })
})

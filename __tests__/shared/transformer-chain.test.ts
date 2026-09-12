/**
 * The derived transformer chain.
 *
 * These cases are the contract that replaced two overlays
 * (services/openai-overlay.ts, and the chain half of
 * services/subscription-overlay.ts) which each selected transformers from
 * a provider's name and base URL. The chain a provider runs is now a
 * function of `api_style` + `auth_mode` alone, so what is pinned here is
 * mostly "the shipped providers still get the chain they got before".
 */
import { describe, expect, test } from 'bun:test'
import {
  type ChainProvider,
  effectiveApiStyle,
  modelTransformerChains,
  transformerChain
} from '../../src/shared/transformer-chain'

const provider = (over: Partial<ChainProvider>): ChainProvider => ({
  name: 'p',
  api_base_url: 'https://example.test/v1/chat/completions',
  auth_mode: 'api_key',
  ...over
})

describe('api_key providers', () => {
  test('an openai_chat provider converts through openai', () => {
    expect(transformerChain(provider({ name: 'openai', api_style: 'openai_chat' }))).toEqual(['openai'])
  })

  test('every openai-compatible vendor gets the same chain, whatever its base URL', () => {
    // The overlay this replaced keyed off the base URL and matched only
    // api.openai.com / a path ending in /chat/completions, so minimax
    // (…/v1/text/chatcompletion_v2) fell through with no conversion step
    // at all and sent the unified body raw.
    const minimax = provider({
      name: 'minimax',
      api_style: 'openai_chat',
      api_base_url: 'https://api.minimax.chat/v1/text/chatcompletion_v2'
    })
    expect(transformerChain(minimax)).toEqual(['openai'])
  })

  test('deepseek gets openai rather than the transformer that never existed', () => {
    // VENDOR_DEFAULTS used to seed `use: ['deepseek']`, a name nothing
    // registers. It resolved to an empty chain and silently disabled the
    // OpenAI request rewrites for that vendor.
    const deepseek = provider({
      name: 'deepseek',
      api_style: 'openai_chat',
      api_base_url: 'https://api.deepseek.com/chat/completions'
    })
    expect(transformerChain(deepseek)).toEqual(['openai'])
  })

  test('a gemini provider converts through gemini', () => {
    expect(transformerChain(provider({ name: 'google', api_style: 'gemini' }))).toEqual(['gemini'])
  })

  test('an anthropic API-key provider preserves native requests through the endpoint auth path', () => {
    // The unified body is Chat-shaped, not Anthropic-shaped. A sole native
    // endpoint step selects the passthrough body and its API-key auth hook.
    expect(transformerChain(provider({ name: 'anthropic', api_style: 'anthropic' }))).toEqual(['anthropic'])
  })

  test('a provider with no stored api_style is unservable', () => {
    expect(transformerChain(provider({}))).toBeNull()
  })
})

describe('subscription providers', () => {
  test('claude-code authenticates through claude-code-oauth alone', () => {
    const p = provider({
      name: 'claude-code',
      auth_mode: 'subscription',
      api_style: 'anthropic',
      api_base_url: 'https://api.anthropic.com/v1/messages'
    })
    expect(transformerChain(p)).toEqual(['claude-code-oauth'])
  })

  test('codex converts first and authenticates last', () => {
    // Order is load-bearing: codex-oauth has to see the Responses-shaped
    // body it is signing.
    const p = provider({
      name: 'codex',
      auth_mode: 'subscription',
      api_style: 'openai_responses',
      api_base_url: 'https://chatgpt.com/backend-api/codex'
    })
    expect(transformerChain(p)).toEqual(['openai-responses', 'codex-oauth'])
  })

  test('a self-hosted proxy under a non-canonical name resolves by base URL', () => {
    // apiStyleForVendor has only the name to go on and lands these on
    // openai_chat. Without the fallback the provider would lose its auth
    // step and be called with the placeholder key.
    const p = provider({
      name: 'my-claude',
      auth_mode: 'subscription',
      api_style: 'openai_chat',
      api_base_url: 'https://anthropic.com.internal.example/v1/messages'
    })
    expect(effectiveApiStyle(p)).toBe('anthropic')
    expect(transformerChain(p)).toEqual(['claude-code-oauth'])
  })

  test('a vendor with no auth transformer is unservable rather than unauthenticated', () => {
    const p = provider({
      name: 'gemini-cli',
      auth_mode: 'subscription',
      api_style: 'gemini',
      api_base_url: 'https://cloudcode-pa.googleapis.com/v1internal'
    })
    expect(transformerChain(p)).toBeNull()
  })
})

describe('per-model chains', () => {
  const openai = provider({ name: 'openai', api_style: 'openai_chat' })

  test('a model that disagrees with its provider gets its own conversion step', () => {
    // Codex-family models on the regular OpenAI provider are
    // Responses-only upstream and 404 against /chat/completions.
    expect(modelTransformerChains(openai, { 'gpt-5-codex': 'openai_responses' })).toEqual({
      'gpt-5-codex': ['openai-responses']
    })
  })

  test('a model that agrees with its provider gets nothing', () => {
    // Appending the provider's own step again would convert the body twice.
    expect(modelTransformerChains(openai, { 'gpt-5': 'openai_chat' })).toEqual({})
  })

  test('subscription providers get no per-model chains', () => {
    // Their chain ends in an auth step that must stay last. The codex
    // provider's models all carry Model.apiStyle = openai_responses, which
    // would otherwise append a second conversion after codex-oauth.
    const codex = provider({
      name: 'codex',
      auth_mode: 'subscription',
      api_style: 'openai_responses',
      api_base_url: 'https://chatgpt.com/backend-api/codex'
    })
    expect(modelTransformerChains(codex, { 'gpt-5-codex': 'openai_responses' })).toEqual({})
  })

  test('no overrides means no per-model chains', () => {
    expect(modelTransformerChains(openai, undefined)).toEqual({})
  })
})

import { describe, expect, test } from 'bun:test'
import { ModelProviderRulesSchema, parseModelProviderRules } from '../../src/schemas/domain/access-token'
import {
  allowsProviderFallback,
  allowsProviderMode,
  DEFAULT_TOKEN_POLICY,
  folderTokenDefaults,
  providerModeFor,
  type TokenPolicy
} from '../../src/shared/access-token-policy'

const policy: TokenPolicy = {
  ...DEFAULT_TOKEN_POLICY,
  providerMode: 'subscription_first',
  providerFallback: true,
  modelProviderRules: [
    { model: 'claude-opus-5', mode: 'api_key_only', fallback: false },
    { model: 'gpt-6-sol', mode: 'api_key_first', fallback: false }
  ]
}

describe('providerModeFor', () => {
  test('a model with a rule follows the rule, and every other model the token', () => {
    expect(providerModeFor(policy, 'claude-opus-5')).toEqual({ mode: 'api_key_only', fallback: false })
    expect(providerModeFor(policy, 'gpt-6-luna')).toEqual({ mode: 'subscription_first', fallback: true })
  })

  test('a rule is matched on the bare name only', () => {
    expect(providerModeFor(policy, 'claude-opus-5-5').mode).toBe('subscription_first')
  })

  test('no token means system priorities', () => {
    expect(providerModeFor(undefined, 'claude-opus-5')).toEqual({ mode: 'system', fallback: false })
  })
})

describe('allowsProviderMode and allowsProviderFallback', () => {
  test('an *_only rule shuts out the other method even when the token falls back', () => {
    expect(allowsProviderMode(policy, 'claude-opus-5', 'api_key')).toBe(true)
    expect(allowsProviderMode(policy, 'claude-opus-5', 'subscription')).toBe(false)
  })

  test('a rule without fallback keeps the token-wide fallback from applying to it', () => {
    expect(allowsProviderMode(policy, 'gpt-6-sol', 'subscription')).toBe(false)
    expect(allowsProviderFallback(policy, 'gpt-6-sol')).toBe(false)
    expect(allowsProviderMode(policy, 'gpt-6-luna', 'api_key')).toBe(true)
    expect(allowsProviderFallback(policy, 'gpt-6-luna')).toBe(true)
  })

  test('a rule can open fallback for one model on a token that has none', () => {
    const strict: TokenPolicy = {
      ...DEFAULT_TOKEN_POLICY,
      providerMode: 'api_key_only',
      modelProviderRules: [{ model: 'gpt-6-sol', mode: 'subscription_first', fallback: true }]
    }
    expect(allowsProviderMode(strict, 'gpt-6-sol', 'api_key')).toBe(true)
    expect(allowsProviderMode(strict, 'gpt-6-sol', 'subscription')).toBe(true)
    expect(allowsProviderMode(strict, 'gpt-6-luna', 'subscription')).toBe(false)
  })
})

test('folder defaults carry no rules', () => {
  const { policy: defaults } = folderTokenDefaults({
    id: 'f',
    name: 'Folder',
    parentId: null,
    defaultPlanId: null,
    defaultProviderMode: 'api_key_first',
    defaultProviderFallback: true
  })
  expect(defaults.modelProviderRules).toEqual([])
})

describe('the stored rules', () => {
  test('two rules for one model are refused', () => {
    const twice = [
      { model: 'gpt-6-sol', mode: 'api_key_only', fallback: false },
      { model: 'gpt-6-sol', mode: 'subscription_only', fallback: false }
    ]
    expect(ModelProviderRulesSchema.safeParse(twice).success).toBe(false)
  })

  test('a rule keyed by provider,model is refused', () => {
    const qualified = [{ model: 'openai,gpt-6-sol', mode: 'api_key_only', fallback: false }]
    expect(ModelProviderRulesSchema.safeParse(qualified).success).toBe(false)
  })

  test('a column that does not parse reads as no rules', () => {
    expect(parseModelProviderRules([{ model: 'gpt-6-sol', mode: 'cheapest' }])).toEqual([])
    expect(parseModelProviderRules(null)).toEqual([])
  })
})

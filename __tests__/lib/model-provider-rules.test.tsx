import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { ModelProviderRules, servingMethods } from '../../src/components/rialto/settings/access/ModelProviderRules'
import type { PlanWire } from '../../src/lib/api'
import en from '../../src/locales/en.json'
import { DEFAULT_TOKEN_POLICY, type TokenPolicy } from '../../src/shared/access-token-policy'

const i18n = createInstance()
await i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  initImmediate: false
})

const PROVIDERS = [
  { name: 'codex', auth_mode: 'subscription' },
  { name: 'openai', auth_mode: 'api_key' },
  { name: 'google', auth_mode: 'subscription' }
] as const
const AVAILABLE = ['codex,gpt-6-sol', 'codex,gpt-6-luna', 'openai,gpt-6-sol', 'google,gemini-3-pro']

const plan = (models: string[]): PlanWire => ({
  id: 'p',
  name: 'Plan',
  models,
  defaultModel: models[0],
  fiveHourRequestLimit: null,
  fiveHourSpendLimitUsd: null,
  sevenDayRequestLimit: null,
  sevenDaySpendLimitUsd: null,
  tokenCount: 0,
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T00:00:00.000Z'
})

describe('servingMethods', () => {
  test('groups providers by bare model and lists subscription first', () => {
    const served = servingMethods(AVAILABLE, PROVIDERS, undefined, DEFAULT_TOKEN_POLICY)
    expect([...served]).toEqual([
      ['gemini-3-pro', ['subscription']],
      ['gpt-6-luna', ['subscription']],
      ['gpt-6-sol', ['subscription', 'api_key']]
    ])
  })

  test('a plan narrows a model to the providers it lists', () => {
    const served = servingMethods(AVAILABLE, PROVIDERS, plan(['codex,gpt-6-sol']), DEFAULT_TOKEN_POLICY)
    expect([...served]).toEqual([['gpt-6-sol', ['subscription']]])
  })

  test("the token's own model limit narrows it too", () => {
    const policy: TokenPolicy = { ...DEFAULT_TOKEN_POLICY, restrictModels: true, allowedModels: ['openai,gpt-6-sol'] }
    expect([...servingMethods(AVAILABLE, PROVIDERS, undefined, policy)]).toEqual([['gpt-6-sol', ['api_key']]])
  })
})

const render = (policy: TokenPolicy, tokenPlan?: PlanWire) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ModelProviderRules
        policy={policy}
        onChange={() => undefined}
        available={AVAILABLE}
        providers={PROVIDERS}
        plan={tokenPlan}
      />
    </I18nextProvider>
  )

describe('ModelProviderRules', () => {
  test('draws each rule with its model and its own mode, without repeating the methods', () => {
    const html = render({
      ...DEFAULT_TOKEN_POLICY,
      modelProviderRules: [{ model: 'gpt-6-sol', mode: 'api_key_first' }]
    })
    expect(html).toContain('>Override<')
    expect(html).toContain('gpt-6-sol')
    // Only a model served both ways can be added, so the rule does not repeat its methods.
    expect(html).not.toContain('subscription · API key')
    // A Prefer mode already means it may fall back; there is no separate box.
    expect(html).not.toContain('role="checkbox"')
    expect(html).toContain('Remove the rule for gpt-6-sol')
  })

  test('says so when a rule insists on a method nothing serves for this token', () => {
    const html = render(
      {
        ...DEFAULT_TOKEN_POLICY,
        modelProviderRules: [{ model: 'gpt-6-sol', mode: 'api_key_only' }]
      },
      plan(['codex,gpt-6-sol'])
    )
    expect(html).toContain('No API key serves it, so requests are refused.')
  })

  test('says so when the token cannot reach the model at all', () => {
    const html = render(
      {
        ...DEFAULT_TOKEN_POLICY,
        modelProviderRules: [{ model: 'gpt-6-sol', mode: 'api_key_first' }]
      },
      plan(['google,gemini-3-pro'])
    )
    expect(html).toContain('This token cannot use it.')
  })

  test('Add a model is disabled once no model is left with a choice', () => {
    const open = render(DEFAULT_TOKEN_POLICY)
    expect(open).toMatch(/<button[^>]*aria-haspopup="listbox"(?![^>]*disabled)[^>]*>/)
    const done = render({
      ...DEFAULT_TOKEN_POLICY,
      modelProviderRules: [{ model: 'gpt-6-sol', mode: 'api_key_first' }]
    })
    expect(done).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*disabled[^>]*>/)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  applyDraft,
  applySubscriptionDraft,
  EMPTY_DRAFT,
  savePlan
} from '../../../src/components/rialto/providers/provider-draft'
import type { Provider, SubAccountWire, SubscriptionWire } from '../../../src/components/rialto/providers/types'

const provider: Provider = {
  name: 'claude-code',
  enabled: true,
  auth_mode: 'subscription',
  api_base_url: 'https://api.anthropic.com',
  api_key: null,
  models: ['claude-sonnet-5'],
  subscription_accounts: [
    { id: 'first', enabled: true },
    { id: 'spare', enabled: false }
  ]
}
const account = (id: string, enabled: boolean): SubAccountWire => ({
  id,
  enabled,
  label: id,
  sourcePath: `oauth:claude:${id}`,
  userName: null,
  userEmail: `${id}@example.com`,
  userId: id,
  plan: 'claude_max',
  rateLimitTier: 'default_claude_max_20x',
  monthlyPriceUsd: null,
  expiresAt: null,
  subscriptionEndsAt: null,
  authStatus: 'live',
  authCheckedAt: null,
  authError: null,
  scopes: []
})
const subscription: SubscriptionWire = {
  providerName: provider.name,
  kind: 'claude',
  enabled: true,
  accounts: [account('first', true), account('spare', false)]
}

describe('subscription account drafts', () => {
  test('previews switches without changing authentication or the loaded rows', () => {
    const draft = { ...EMPTY_DRAFT, accounts: { first: false, spare: true } }
    expect(applyDraft(provider, draft, {}).subscription_accounts).toEqual([
      { id: 'first', enabled: false },
      { id: 'spare', enabled: true }
    ])
    const shown = applySubscriptionDraft(subscription, draft)
    expect(shown?.accounts).toEqual([
      { ...subscription.accounts[0], enabled: false },
      { ...subscription.accounts[1], enabled: true }
    ])
    expect(subscription.accounts[0].enabled).toBe(true)
    expect(provider.subscription_accounts).toEqual([
      { id: 'first', enabled: true },
      { id: 'spare', enabled: false }
    ])
    expect(applySubscriptionDraft(undefined, draft)).toBeUndefined()
  })

  test('saves only changed account ids, without overwriting a peer', () => {
    const plan = savePlan(provider, { ...EMPTY_DRAFT, accounts: { first: false } }, {})
    expect(plan.upsert?.subscription_accounts).toEqual([{ id: 'first', enabled: false }])
    expect(plan.upsert?.models).toEqual(provider.models)
    expect(plan.aliases).toEqual([])
    expect(plan.efforts).toEqual([])
  })

  test('account and model switches share one upsert', () => {
    const plan = savePlan(
      provider,
      {
        ...EMPTY_DRAFT,
        accounts: { first: false, spare: true },
        models: { 'claude-sonnet-5': false }
      },
      {}
    )
    expect(plan.upsert?.subscription_accounts).toEqual([
      { id: 'first', enabled: false },
      { id: 'spare', enabled: true }
    ])
    expect(plan.upsert?.transformer?._disabledModels).toEqual(['claude-sonnet-5'])
  })

  test('a switch returned to its loaded state is a no-op', () => {
    expect(savePlan(provider, { ...EMPTY_DRAFT, accounts: { first: true, spare: false } }, {}).upsert).toBeNull()
  })

  test('unknown ids and accounts on API-key providers are ignored', () => {
    expect(savePlan(provider, { ...EMPTY_DRAFT, accounts: { foreign: false } }, {}).upsert).toBeNull()
    expect(
      savePlan({ ...provider, auth_mode: 'api_key' }, { ...EMPTY_DRAFT, accounts: { first: false } }, {}).upsert
    ).toBeNull()
  })

  test('model-only saves omit all account flags rather than replaying a stale snapshot', () => {
    const plan = savePlan(provider, { ...EMPTY_DRAFT, models: { 'claude-sonnet-5': false } }, {})
    expect(plan.upsert).not.toBeNull()
    expect(plan.upsert?.subscription_accounts).toBeUndefined()
    expect(JSON.stringify(plan.upsert)).not.toContain('subscription_accounts')
  })

  test('the last enabled account may be disabled and a disabled account may be restored', () => {
    const disabled = savePlan(provider, { ...EMPTY_DRAFT, accounts: { first: false } }, {})
    expect(disabled.upsert?.subscription_accounts).toEqual([{ id: 'first', enabled: false }])
    const reenabled = savePlan(provider, { ...EMPTY_DRAFT, accounts: { spare: true } }, {})
    expect(reenabled.upsert?.subscription_accounts).toEqual([{ id: 'spare', enabled: true }])
  })
})

/**
 * The two screens that disagreed about what "enabled" means.
 *
 * `Provider.enabled` is the flag Routing filters on. The Providers screen
 * reports a provider's state from `providerState`, and that function used
 * to answer from the credential alone — so a signed-in Claude Code with
 * `enabled: false` read as `live` on one screen while Routing dropped
 * every one of its models on the other, with no control anywhere to
 * reconcile them.
 *
 * These tests pin the two halves against each other: whatever
 * `enabledTargets` refuses to route to must not be called live.
 */

import { describe, expect, test } from 'bun:test'
import { hasCredential, providerState } from '../../src/components/rialto/providers/derive'
import type { Provider, SubscriptionWire } from '../../src/components/rialto/providers/types'
import { enabledTargets } from '../../src/components/rialto/routing/derive'

const subProvider = (over: Partial<Provider> = {}): Provider => ({
  name: 'claude-code',
  api_base_url: 'https://api.anthropic.com',
  api_key: null,
  auth_mode: 'subscription',
  enabled: true,
  models: ['claude-opus-4-8', 'claude-sonnet-5'],
  ...over
})

const account = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  label: 'acct',
  enabled: true,
  plan: 'claude_max',
  authStatus: 'live',
  userName: null,
  userEmail: null,
  ...over
})

const sub = (over: Record<string, unknown> = {}): SubscriptionWire =>
  ({
    providerName: 'claude-code',
    kind: 'claude',
    enabled: true,
    accounts: [account()],
    ...over
  }) as unknown as SubscriptionWire

const liveSub = sub()

describe('providerState', () => {
  test('a switched-off provider reads off, however live its credential', () => {
    // The symptom itself: this used to return 'live'.
    expect(providerState(subProvider({ enabled: false }), liveSub)).toBe('off')
  })

  test('a switched-on provider still reports its credential health', () => {
    expect(providerState(subProvider(), liveSub)).toBe('live')
  })

  test('off wins over an absent credential too — the switch is the operative fact', () => {
    expect(providerState(subProvider({ enabled: false }), undefined)).toBe('off')
    expect(providerState(subProvider(), undefined)).toBe('unknown')
  })

  test('an api_key provider with no key is unknown, not off, while it is switched on', () => {
    const p = subProvider({ auth_mode: 'api_key', api_key: null, enabled: true })
    expect(providerState(p, undefined)).toBe('unknown')
  })
})

describe('the Providers screen and Routing agree', () => {
  test('a provider Routing will not offer is never shown as live', () => {
    const off = subProvider({ enabled: false })
    expect(enabledTargets([off])).toHaveLength(0)
    expect(providerState(off, liveSub)).not.toBe('live')
  })

  test('switching it on puts its models back in reach', () => {
    const on = subProvider()
    expect(enabledTargets([on]).map((entry) => entry.target)).toEqual([
      'claude-code,claude-opus-4-8',
      'claude-code,claude-sonnet-5'
    ])
    expect(providerState(on, liveSub)).toBe('live')
  })
})

/**
 * The switch is locked exactly when turning it on would change nothing:
 * `getEnabledModels` drops a provider with no credential whatever the
 * flag says, so offering the control there would be offering a setting
 * nothing reads.
 *
 * The threshold is deliberately NOT `providerState() === 'live'`. For an
 * api_key provider `live` means a model test has passed, so a key that
 * works but has never been tested reads `unknown` — locking on liveness
 * would strand every freshly added key with no way to switch it on, the
 * same trap this change exists to remove.
 */
describe("hasCredential — when the switch is the operator's to set", () => {
  test('a subscription with an account on a resolved plan has one', () => {
    expect(hasCredential(subProvider(), liveSub)).toBe(true)
  })

  test('a subscription with no accounts at all does not', () => {
    expect(hasCredential(subProvider(), undefined)).toBe(false)
  })

  test('an account whose plan never resolved does not count', () => {
    const unresolved = sub({ accounts: [account({ plan: null })] })
    expect(hasCredential(subProvider(), unresolved)).toBe(false)
  })

  // The question is about the provider, not about one designated row:
  // the binding that used to answer it is gone, and a healthy peer now
  // keeps the provider routable rather than being ignored.
  test('one healthy account is enough, whatever shape the others are in', () => {
    const mixed = sub({ accounts: [account({ id: 'a0', plan: null }), account({ id: 'a1' })] })
    expect(hasCredential(subProvider(), mixed)).toBe(true)
  })

  test('a disabled account does not count', () => {
    const off = sub({ accounts: [account({ enabled: false })] })
    expect(hasCredential(subProvider(), off)).toBe(false)
  })

  test('an api_key provider needs only a non-empty key', () => {
    expect(hasCredential(subProvider({ auth_mode: 'api_key', api_key: 'sk-x' }), undefined)).toBe(true)
    expect(hasCredential(subProvider({ auth_mode: 'api_key', api_key: '   ' }), undefined)).toBe(false)
    expect(hasCredential(subProvider({ auth_mode: 'api_key', api_key: null }), undefined)).toBe(false)
  })

  test('an untested api_key provider is not live, but its switch stays settable', () => {
    // The regression this threshold avoids: `unknown` is the resting
    // state of a key nobody has run a model test against.
    const fresh = subProvider({ auth_mode: 'api_key', api_key: 'sk-x' })
    expect(providerState(fresh, undefined)).toBe('unknown')
    expect(hasCredential(fresh, undefined)).toBe(true)
  })

  test('a subscription whose probe came back invalid keeps its switch too', () => {
    // The credential exists and the server would still route to it; the
    // probe verdict is not the same claim as "there is nothing here".
    const bad = sub({ accounts: [account({ authStatus: 'invalid' })] })
    expect(providerState(subProvider(), bad)).toBe('invalid')
    expect(hasCredential(subProvider(), bad)).toBe(true)
  })
})

import type { ModelProviderRule } from '@/schemas/domain/access-token'
import { apiKeyVendorName } from './custom-provider'

export const TOKEN_PROVIDER_MODES = [
  'system',
  'subscription_only',
  'api_key_only',
  'subscription_first',
  'api_key_first'
] as const

/**
 * Which billing method serves a token's requests. A `_first` mode moves on to
 * the other method after a 429/503; an `_only` mode never does. There is no
 * separate fallback switch: a preferred method that may not fall back is
 * exactly `_only`, so the mode alone says it.
 */
export type TokenProviderMode = (typeof TOKEN_PROVIDER_MODES)[number]
export type ProviderAuthMode = 'api_key' | 'subscription'

export interface TokenPolicy {
  restrictModels: boolean
  allowedModels: string[]
  providerMode: TokenProviderMode
  /**
   * Models that choose their own billing method. A model not listed follows
   * providerMode. Token-only: folders do not carry rules,
   * so moving a token between folders leaves them alone.
   */
  modelProviderRules: ModelProviderRule[]
}

export const DEFAULT_TOKEN_POLICY: TokenPolicy = {
  restrictModels: false,
  allowedModels: [],
  providerMode: 'system',
  modelProviderRules: []
}

export interface TokenFolder {
  id: string
  name: string
  parentId: string | null
  defaultPlanId: string | null
  defaultProviderMode: TokenProviderMode
}

export function folderTokenDefaults(folder: TokenFolder | null | undefined): {
  planId: string | null
  policy: TokenPolicy
} {
  if (folder == null) return { planId: null, policy: DEFAULT_TOKEN_POLICY }
  return {
    planId: folder.defaultPlanId,
    policy: {
      ...DEFAULT_TOKEN_POLICY,
      providerMode: folder.defaultProviderMode
    }
  }
}

export function preferredAuthMode(mode: TokenProviderMode): ProviderAuthMode | undefined {
  if (mode === 'system') return undefined
  return mode.startsWith('subscription') ? 'subscription' : 'api_key'
}

/**
 * The billing-method setting one model is served under: its own rule when the
 * token has one for it, otherwise the token's. `model` is the bare name the
 * request resolved to (after a stale id was updated to its newest release),
 * so a rule is matched against the model actually served.
 *
 * Every request-path decision about subscription versus API key goes through
 * here rather than reading providerMode, so a rule reaches all of them: which
 * providers are eligible, the order they are tried in, and whether a 429/503
 * may move on to the other billing method.
 */
export function providerModeFor(policy: TokenPolicy | undefined, model: string): TokenProviderMode {
  if (policy === undefined) return 'system'
  const rule = policy.modelProviderRules.find((entry) => entry.model === model)
  return rule === undefined ? policy.providerMode : rule.mode
}

/** A `_first` mode may retry on the other billing method after a 429/503. */
export function allowsProviderFallback(policy: TokenPolicy | undefined, model: string): boolean {
  return providerModeFor(policy, model).endsWith('_first')
}

export function allowsProviderMode(policy: TokenPolicy | undefined, model: string, mode: ProviderAuthMode): boolean {
  const setting = providerModeFor(policy, model)
  if (setting === 'system') return true
  return preferredAuthMode(setting) === mode || allowsProviderFallback(policy, model)
}

/** API-key rows for one vendor share a token selector; subscriptions keep their own identity. */
export function tokenProviderGroup(provider: string, authMode: ProviderAuthMode): string {
  return authMode === 'api_key' ? apiKeyVendorName(provider) : provider
}

export function allowsTokenModel(
  policy: TokenPolicy | undefined,
  model: string,
  target?: { provider: string; authMode: ProviderAuthMode }
): boolean {
  if (policy === undefined || !policy.restrictModels || policy.allowedModels.includes(model)) return true
  if (target === undefined) return policy.allowedModels.some((selector) => selector.endsWith(`,${model}`))
  return policy.allowedModels.includes(`${tokenProviderGroup(target.provider, target.authMode)},${model}`)
}

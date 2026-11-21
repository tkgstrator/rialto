import { apiKeyVendorName } from './custom-provider'

export const TOKEN_PROVIDER_MODES = [
  'system',
  'subscription_only',
  'api_key_only',
  'subscription_first',
  'api_key_first'
] as const

export type TokenProviderMode = (typeof TOKEN_PROVIDER_MODES)[number]
export type ProviderAuthMode = 'api_key' | 'subscription'

export interface TokenPolicy {
  restrictModels: boolean
  allowedModels: string[]
  providerMode: TokenProviderMode
  providerFallback: boolean
}

export const DEFAULT_TOKEN_POLICY: TokenPolicy = {
  restrictModels: false,
  allowedModels: [],
  providerMode: 'system',
  providerFallback: false
}

export interface TokenFolder {
  id: string
  name: string
  parentId: string | null
  defaultPlanId: string | null
  defaultProviderMode: TokenProviderMode
  defaultProviderFallback: boolean
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
      providerMode: folder.defaultProviderMode,
      providerFallback: folder.defaultProviderFallback
    }
  }
}

export function preferredAuthMode(mode: TokenProviderMode): ProviderAuthMode | undefined {
  if (mode === 'system') return undefined
  return mode.startsWith('subscription') ? 'subscription' : 'api_key'
}

export function allowsProviderMode(policy: TokenPolicy | undefined, mode: ProviderAuthMode): boolean {
  if (policy === undefined || policy.providerMode === 'system') return true
  return (
    preferredAuthMode(policy.providerMode) === mode ||
    (policy.providerMode.endsWith('_first') && policy.providerFallback)
  )
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

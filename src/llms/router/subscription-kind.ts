/**
 * Which subscription usage window a provider's 429 is attributed to.
 *
 * The reactive 429 path rotates accounts inside one subscription provider
 * and marks the one that hit its limit; to do that it has to know which
 * vendor's windows the provider draws on. Mirrors the apiBaseUrl matching
 * in subscription-account-sync-service.
 */

import type { ConfigProvider } from './types'

// Provider shape the kind sniffer needs. Re-exported with the helper so
// callers in the route layer can build the same minimal ConfigProvider
// view from the live ConfigStore without depending on the full schema.
export type SubscriptionKindProvider = ConfigProvider

// null for api_key and other non-subscription providers.
export function subscriptionKindOf(providerName: string, providers: ConfigProvider[]): 'claude' | 'codex' | null {
  const p = providers.find((x) => x.name === providerName)
  if (p?.auth_mode !== 'subscription') return null
  const url = typeof p.api_base_url === 'string' ? p.api_base_url : ''
  if (url.includes('anthropic.com')) return 'claude'
  if (url.includes('chatgpt.com') || url.includes('openai.com/v1')) return 'codex'
  return null
}

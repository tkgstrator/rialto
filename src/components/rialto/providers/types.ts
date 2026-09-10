/**
 * Wire shapes the Providers screens read.
 *
 * The response envelopes are declared here rather than added to
 * `lib/api.ts`: these screens are their only readers, and the generic
 * `api.get<T>` / `api.post<T>` already carry the type through. `Provider`
 * and `CatalogEntry` come from `@/schemas` because those ARE the wire
 * contract — re-typing them here would let the two drift.
 */
import type { CatalogEntry } from '@/schemas/api/catalog'
import type { Provider } from '@/schemas/domain/provider'
export type ApiStyle = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini'
export type AuthStatus = 'unknown' | 'live' | 'invalid'
export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku'
/** Mirrors the OpenAI ReasoningEffort enum the PATCH endpoint accepts. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type TestStatus = 'unknown' | 'ok' | 'fail'

/** One SubAccount as GET /api/subscriptions reports it. */
export interface SubAccountWire {
  id: string
  label: string
  sourcePath: string
  enabled: boolean
  userName: string | null
  userEmail: string | null
  userId: string | null
  plan: string | null
  rateLimitTier: string | null
  monthlyPriceUsd: number | null
  expiresAt: number | null
  subscriptionEndsAt: number | null
  authStatus: AuthStatus
  authCheckedAt: number | null
  authError: string | null
  scopes: string[]
}

export interface SubscriptionWire {
  providerName: string
  kind: 'claude' | 'codex' | 'other'
  enabled: boolean
  accounts: SubAccountWire[]
}

export interface SubscriptionsResponse {
  subscriptions: SubscriptionWire[]
}

export interface CatalogResponse {
  entries: CatalogEntry[]
}

/** One registered transformer and the endpoint path it speaks. */
export interface TransformerWire {
  name: string
  endpoint: string | null
}

export interface TransformersResponse {
  transformers: TransformerWire[]
}

export interface ProviderTestResponse {
  success: boolean
  latencyMs?: number
  error?: string
}

export interface ModelTestResponse {
  provider: string
  model: string
  status: TestStatus
  error?: string
  latencyMs: number
}

export interface OAuthInitiateResponse {
  success: boolean
  authorizeUrl?: string
  state?: string
  error?: string
}

export interface OAuthSubmitResponse {
  success: boolean
  error?: string
}

export type { CatalogEntry, Provider }

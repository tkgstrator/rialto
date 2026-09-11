/**
 * What /api/subscriptions and /api/enabled-models return. Derived from
 * the domain account shape with every token field dropped and the Date
 * columns flattened to epoch numbers for the browser.
 */

import { z } from '@hono/zod-openapi'
import { AuthStatusSchema } from '@/schemas/domain/subscription'

export const SubscriptionInfoSchema = z
  .object({
    id: z.string().nonempty(),
    label: z.string().nonempty(),
    sourcePath: z.string().nonempty(),
    enabled: z.boolean(),
    userName: z.string().nonempty().nullable(),
    userEmail: z.string().nonempty().nullable(),
    userId: z.string().nonempty().nullable(),
    plan: z.string().nonempty().nullable(),
    rateLimitTier: z.string().nonempty().nullable(),
    monthlyPriceUsd: z.number().nullable(),
    // Auto-refreshed access-token expiry, for both vendors. Not a health
    // signal on its own — a token at or past expiry is rotated on next
    // use; authStatus is the authoritative "does this authenticate" bit.
    expiresAt: z.number().nullable(),
    // Codex only: when the paid subscription lapses. Null for Claude.
    subscriptionEndsAt: z.number().nullable(),
    authStatus: AuthStatusSchema,
    authCheckedAt: z.number().nullable(),
    authError: z.string().nonempty().nullable(),
    scopes: z.array(z.string().nonempty())
  })
  .openapi('SubscriptionAccountInfo')

export const SubscriptionProviderInfoSchema = z
  .object({
    providerName: z.string().nonempty(),
    // Vendor family, derived from the provider's apiBaseUrl. Lets the UI
    // pick the right usage-window shape and group accounts without hard-
    // coding provider names.
    kind: z.enum(['claude', 'codex', 'other']),
    enabled: z.boolean(),
    // Every connected account. No account is designated: the proxy
    // picks one per request (session-account-router) and the gates ask
    // whether ANY of these can authenticate (shared/subscription-credential).
    accounts: z.array(SubscriptionInfoSchema)
  })
  .openapi('SubscriptionInfo')

export const SubscriptionsResponseSchema = z
  .object({
    subscriptions: z.array(SubscriptionProviderInfoSchema)
  })
  .openapi('SubscriptionsResponse')

// A failure names the account rather than counting it: the Providers list
// shows accounts by label, and "1 of 10 failed" would send the operator
// checking all ten.
const SubscriptionRefreshFailureSchema = z
  .object({
    subAccountId: z.string().nonempty(),
    label: z.string().nonempty(),
    providerName: z.string().nonempty()
  })
  .openapi('SubscriptionRefreshFailure')

// No body, or one without `provider`, refreshes every account on an
// enabled subscription provider — the Subscriptions list's Refresh.
// `provider` narrows it to that provider's accounts, switched on or not:
// its own page asks about the provider it shows, and a switched-off
// provider is when an operator most wants to know whether its credentials
// still work.
export const SubscriptionRefreshRequestSchema = z
  .object({ provider: z.string().nonempty().optional() })
  .openapi('SubscriptionRefreshRequest')

export const SubscriptionRefreshErrorSchema = z
  .object({ error: z.string().nonempty() })
  .openapi('SubscriptionRefreshError')

export const SubscriptionRefreshResponseSchema = z
  .object({
    // The accounts the refresh was pointed at: every account on an enabled
    // subscription provider, or every account on the one provider named.
    attempted: z.number().int().nonnegative(),
    // Of those, the accounts whose profile sync and usage fetch both answered.
    refreshed: z.number().int().nonnegative(),
    failed: z.array(SubscriptionRefreshFailureSchema)
  })
  .openapi('SubscriptionRefreshResponse')

export type SubscriptionRefreshResponse = z.infer<typeof SubscriptionRefreshResponseSchema>

export const EnabledModelSchema = z
  .object({
    provider: z.string().nonempty(),
    model: z.string().nonempty()
  })
  .openapi('EnabledModel')

export const EnabledModelsResponseSchema = z
  .object({
    models: z.array(EnabledModelSchema)
  })
  .openapi('EnabledModelsResponse')

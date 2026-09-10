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

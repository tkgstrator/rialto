import type { z } from '@hono/zod-openapi'
import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'
import type { SubscriptionInfoSchema, SubscriptionProviderInfoSchema } from '../schemas/api/subscriptions'

export type SubscriptionAccountInfo = z.infer<typeof SubscriptionInfoSchema>
export type SubscriptionInfo = z.infer<typeof SubscriptionProviderInfoSchema>

// Map a provider's apiBaseUrl to a vendor family for the UI. Mirrors the
// substring matching in getSubAccountTokensForKind so the two stay in sync.
const providerKind = (apiBaseUrl: string): 'claude' | 'codex' | 'other' => {
  if (apiBaseUrl.includes('anthropic.com')) return 'claude'
  if (apiBaseUrl.includes('chatgpt.com') || apiBaseUrl.includes('openai.com/v1')) return 'codex'
  return 'other'
}

const toAccountInfo = (a: {
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
  expiresAt: Date | null
  subscriptionEndsAt: Date | null
  authStatus: 'unknown' | 'live' | 'invalid'
  authCheckedAt: Date | null
  authError: string | null
  scopes: unknown
}): SubscriptionAccountInfo => ({
  id: a.id,
  label: a.label,
  sourcePath: a.sourcePath,
  enabled: a.enabled,
  userName: a.userName,
  userEmail: a.userEmail,
  userId: a.userId,
  plan: a.plan,
  rateLimitTier: a.rateLimitTier,
  monthlyPriceUsd: a.monthlyPriceUsd,
  expiresAt: a.expiresAt ? a.expiresAt.valueOf() : null,
  subscriptionEndsAt: a.subscriptionEndsAt ? a.subscriptionEndsAt.valueOf() : null,
  authStatus: a.authStatus,
  authCheckedAt: a.authCheckedAt ? a.authCheckedAt.valueOf() : null,
  authError: a.authError,
  scopes: Array.isArray(a.scopes) ? a.scopes.filter((s): s is string => typeof s === 'string') : []
})

export async function getSubscriptionsInfo(prisma: PrismaClient = getPrismaClient()): Promise<SubscriptionInfo[]> {
  const providers = await prisma.provider.findMany({
    where: { authMode: 'subscription' },
    include: { subscriptionAccounts: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' }
  })
  return providers.map((p) => ({
    providerName: p.name,
    kind: providerKind(p.apiBaseUrl),
    enabled: p.enabled,
    accounts: p.subscriptionAccounts.map(toAccountInfo)
  }))
}

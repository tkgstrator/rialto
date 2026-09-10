/**
 * Every routable model, straight from the DB (Model.enabled is the
 * source of truth). Powers the Router selects — they render this list
 * verbatim, so disabled models never reach that UI and the frontend
 * does zero filtering. Separate from /api/config, which intentionally
 * returns the full catalog (ModelsDashboard needs the disabled ones).
 */

import { hasAuthenticableAccount } from '@/shared/subscription-credential'
import { getPrismaClient } from '../../db/client'
import { AuthMode, type PrismaClient } from '../../generated/prisma/client'
import { getSubscriptionsInfo } from '../subscription-info-service'

export async function getEnabledModels(
  prisma: PrismaClient = getPrismaClient()
): Promise<{ provider: string; model: string }[]> {
  const rows = await prisma.model.findMany({
    where: { enabled: true },
    select: { name: true, provider: { select: { name: true, apiKey: true, authMode: true, enabled: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }]
  })
  // Only providers that can actually authenticate are routable: an
  // api_key provider needs a non-empty key; a subscription provider
  // needs at least one account with a resolved plan. Mirrors the models
  // dashboard's availability gate — literally, via the shared predicate
  // — so the Router never lists models from unconfigured seed providers
  // (e.g. an empty-key google).
  const subs = await getSubscriptionsInfo()
  const subCredentialed = new Map(
    subs.map((s) => [s.providerName, s.enabled && hasAuthenticableAccount(s.accounts)] as const)
  )
  return rows
    .filter(
      (r) =>
        r.provider.enabled &&
        (r.provider.authMode === AuthMode.subscription
          ? subCredentialed.get(r.provider.name) === true
          : r.provider.apiKey !== null && r.provider.apiKey.trim().length > 0)
    )
    .map((r) => ({ provider: r.provider.name, model: r.name }))
}

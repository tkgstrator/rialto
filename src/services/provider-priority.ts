import { getPrismaClient } from '../db/client'
import { AuthMode } from '../generated/prisma/client'
import {
  compareProviderPriority,
  PROVIDER_PRIORITY_GROUPS,
  type ProviderPriorityGroup,
  providerPriorityGroup
} from '../shared/provider-priority'

const eligibleProviders = {
  enabled: true,
  models: { some: { enabled: true, deprecated: false } },
  OR: [{ authMode: AuthMode.subscription }, { authMode: AuthMode.api_key, apiKey: { not: null } }]
}

export async function listProviderPriorityGroups() {
  const providers = await getPrismaClient().provider.findMany({
    where: eligibleProviders,
    select: { name: true, organizationId: true, displayName: true, routingPriority: true }
  })
  providers.sort(compareProviderPriority)
  return PROVIDER_PRIORITY_GROUPS.map((group) => ({
    group,
    providers: providers
      .filter(({ name }) => providerPriorityGroup(name) === group)
      .map(({ name, organizationId, displayName }) => ({
        name,
        organizationId,
        displayName: group === 'anthropic' && name !== 'claude-code' ? null : displayName
      }))
  }))
}

export async function saveProviderPriorityGroup(
  group: ProviderPriorityGroup,
  names: readonly string[]
): Promise<boolean> {
  return getPrismaClient().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(726139, hashtext(${group}))`
    const providers = await tx.provider.findMany({ where: eligibleProviders, select: { name: true } })
    const available = new Set(
      providers.filter(({ name }) => providerPriorityGroup(name) === group).map(({ name }) => name)
    )
    if (
      names.length !== available.size ||
      new Set(names).size !== names.length ||
      names.some((name) => !available.has(name))
    ) {
      return false
    }
    for (const [index, name] of names.entries()) {
      await tx.provider.update({ where: { name }, data: { routingPriority: index + 1 } })
    }
    return true
  })
}

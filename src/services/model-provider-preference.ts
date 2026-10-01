import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'

export interface ModelProviderPriority {
  model: string
  // Available providers in configured order, followed by unranked providers
  // in name order. Only duplicate bare names need a preference.
  providers: string[]
  preferredProviders: string[]
}

interface PreferenceRow {
  modelName: string
  providerName: string
  priority: number
}

const readPreferences = (prisma: PrismaClient, modelName?: string): Promise<PreferenceRow[]> =>
  modelName === undefined
    ? prisma.$queryRaw<PreferenceRow[]>`
        SELECT pref."modelName", provider."name" AS "providerName", pref."priority"
        FROM "ModelProviderPreference" pref
        JOIN "Model" model ON model."id" = pref."modelId" AND model."name" = pref."modelName"
        JOIN "Provider" provider ON provider."id" = model."providerId"
        ORDER BY pref."modelName", pref."priority"
      `
    : prisma.$queryRaw<PreferenceRow[]>`
        SELECT pref."modelName", provider."name" AS "providerName", pref."priority"
        FROM "ModelProviderPreference" pref
        JOIN "Model" model ON model."id" = pref."modelId" AND model."name" = pref."modelName"
        JOIN "Provider" provider ON provider."id" = model."providerId"
        WHERE pref."modelName" = ${modelName}
        ORDER BY pref."priority"
      `

/** The editor lists only names that actually collide across providers. */
export async function listModelProviderPriorities(
  prisma: PrismaClient = getPrismaClient()
): Promise<ModelProviderPriority[]> {
  const [models, preferences] = await Promise.all([
    prisma.model.findMany({ select: { name: true, provider: { select: { name: true } } }, orderBy: { name: 'asc' } }),
    readPreferences(prisma)
  ])
  const names = [...new Set(models.map((model) => model.name))]
  return names.flatMap((model) => {
    const rows = models.filter((row) => row.name === model)
    if (rows.length < 2) return []
    const available = new Set(rows.map((row) => row.provider.name))
    const preferredProviders = preferences
      .filter((row) => row.modelName === model && available.has(row.providerName))
      .map((row) => row.providerName)
    const preferred = new Set(preferredProviders)
    return {
      model,
      preferredProviders,
      providers: [...preferredProviders, ...[...available].filter((provider) => !preferred.has(provider)).sort()]
    }
  })
}

export type SetModelProviderPrioritiesOutcome =
  | { ok: true }
  | { ok: false; reason: 'model-not-found' | 'provider-not-on-model' | 'duplicate-provider'; provider?: string }

/** Replace a bare name's entire preference, including clearing it with []. */
export async function setModelProviderPriorities(
  modelName: string,
  providerNames: readonly string[],
  prisma: PrismaClient = getPrismaClient()
): Promise<SetModelProviderPrioritiesOutcome> {
  const duplicate = providerNames.find((name, index) => providerNames.indexOf(name) !== index)
  if (duplicate !== undefined) return { ok: false, reason: 'duplicate-provider', provider: duplicate }
  return prisma.$transaction(async (tx) => {
    // Serialize writes for the same name so two PUTs cannot interleave their
    // delete and insert phases or both accept a stale view of the ordering.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(726138, hashtext(${modelName}))`
    const models = await tx.model.findMany({
      where: { name: modelName },
      select: { id: true, provider: { select: { name: true } } }
    })
    if (models.length === 0) return { ok: false, reason: 'model-not-found' }
    const byProvider = new Map(models.map((model) => [model.provider.name, model.id]))
    const unknown = providerNames.find((provider) => !byProvider.has(provider))
    if (unknown !== undefined) return { ok: false, reason: 'provider-not-on-model', provider: unknown }
    await tx.$executeRaw`DELETE FROM "ModelProviderPreference" WHERE "modelName" = ${modelName}`
    for (const [index, provider] of providerNames.entries()) {
      const modelId = byProvider.get(provider)
      if (modelId !== undefined) {
        await tx.$executeRaw`INSERT INTO "ModelProviderPreference" ("modelId", "modelName", "priority") VALUES (${modelId}, ${modelName}, ${index + 1})`
      }
    }
    return { ok: true }
  })
}

export type ProviderPreferenceResolution =
  | { status: 'preferred'; provider: string }
  | { status: 'ambiguous' }
  | { status: 'unavailable' }

export type ProviderPreferenceOrder =
  | { status: 'preferred'; providers: string[] }
  | { status: 'ambiguous' }
  | { status: 'unavailable' }

/**
 * Resolve only among targets the caller has already found eligible. If a
 * plan restricts providers, intersect that list first; never use a stored
 * preference to bypass plan or target eligibility. Without a ranked eligible
 * target, multiple candidates remain ambiguous rather than choosing one by
 * their incidental database order.
 */
export async function preferredProviderOrder(
  modelName: string,
  eligibleProviderNames: readonly string[],
  planAllowedProviderNames?: readonly string[],
  prisma: PrismaClient = getPrismaClient()
): Promise<ProviderPreferenceOrder> {
  const planAllowed = planAllowedProviderNames === undefined ? undefined : new Set(planAllowedProviderNames)
  const eligible = new Set(
    eligibleProviderNames.filter((provider) => planAllowed === undefined || planAllowed.has(provider))
  )
  if (eligible.size === 0) return { status: 'unavailable' }
  if (eligible.size === 1) return { status: 'preferred', providers: [...eligible] }
  const preferred = (await readPreferences(prisma, modelName))
    .filter((row) => eligible.has(row.providerName))
    .map((row) => row.providerName)
  return preferred.length === 0 ? { status: 'ambiguous' } : { status: 'preferred', providers: preferred }
}

export async function resolvePreferredProvider(
  modelName: string,
  eligibleProviderNames: readonly string[],
  planAllowedProviderNames?: readonly string[],
  prisma: PrismaClient = getPrismaClient()
): Promise<ProviderPreferenceResolution> {
  const order = await preferredProviderOrder(modelName, eligibleProviderNames, planAllowedProviderNames, prisma)
  return order.status === 'preferred' ? { status: 'preferred', provider: order.providers[0] } : order
}

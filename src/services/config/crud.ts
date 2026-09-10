/**
 * Single-record provider / model CRUD helpers used by the REST API
 * routes. Each mutation runs in its own transaction, then triggers a
 * disk sync + llms-context reset so the changes take effect without a
 * server restart.
 */

import { type Provider, ProviderSchema } from '@/schemas/domain/provider'
import { getPrismaClient } from '../../db/client'
import { ModelTestStatus, type PrismaClient } from '../../generated/prisma/client'
import { resetLlmsContext } from '../../llms'
import { logger } from '../../logger'
import { applyProviderRow } from './apply'
import { chainEntryCascadeWarning } from './apply/chain-entries'
import { toProvider } from './compose'
import { syncToConfigFile } from './sync-to-disk'

export async function getProviders(prisma: PrismaClient = getPrismaClient()): Promise<Provider[]> {
  const providers = await prisma.provider.findMany({
    include: {
      // Ordered for the same reason subscriptionAccounts is: a relation
      // with no orderBy comes back in whatever order Postgres feels like,
      // and an UPDATE moves the row. Toggling a model on the Providers
      // screen therefore reshuffled the table under the operator's
      // cursor. createdAt is the seed/insert order the UI was built
      // around; name breaks the ties, because a createMany batch stamps
      // every row with the same instant.
      models: { orderBy: [{ createdAt: 'asc' }, { name: 'asc' }] },
      subscriptionAccounts: { orderBy: { createdAt: 'asc' } }
    },
    orderBy: { createdAt: 'asc' }
  })
  return providers.map(toProvider)
}

export async function upsertProvider(incoming: Provider): Promise<{ provider: Provider; warnings: string[] }> {
  // Parse to fill in defaults (e.g. `enabled`) and to keep external
  // callers honest. ProviderSchema rejects anything off-shape — the
  // public API routes already pre-parse, this is belt-and-suspenders.
  const parsed = ProviderSchema.parse(incoming)
  const warnings: string[] = []
  const prisma = getPrismaClient()
  await prisma.$transaction(async (tx) => {
    // Fetch the pre-image only for THIS provider (the row-level helper
    // needs the prior model.enabled map for its enabled-flip
    // reconciliation). Do NOT call applyProviders here — that path
    // starts with deleteRemovedProviders, which sees the single-element
    // incoming list and deletes every other provider (and their
    // SubAccount rows via onDelete: Cascade) as "no longer listed".
    // That cascade wiped OAuth credentials on a routine PATCH before
    // this was split.
    const prevProvider = await tx.provider.findUnique({
      where: { name: parsed.name },
      include: { models: true }
    })
    await applyProviderRow(tx, parsed, prevProvider ?? undefined, warnings)
  })
  await syncToConfigFile()
  resetLlmsContext()
  const p = await prisma.provider.findUniqueOrThrow({
    where: { name: parsed.name },
    include: { models: true, subscriptionAccounts: { orderBy: { createdAt: 'asc' } } }
  })
  return { provider: toProvider(p), warnings }
}

// Deleting a provider cascades to its models and from there to every
// chain entry naming one. The entries cannot be kept — their target is
// gone — so the count is returned as a warning and logged, rather than
// the chains quietly getting shorter.
export async function deleteProviderByName(name: string): Promise<{ warnings: string[] }> {
  const prisma = getPrismaClient()
  const warnings: string[] = []
  await prisma.$transaction(async (tx) => {
    const p = await tx.provider.findUnique({ where: { name } })
    if (!p) throw new Error(`Provider "${name}" not found`)
    const cascade = await chainEntryCascadeWarning(tx, { providerId: p.id }, `deleted provider "${name}"`)
    if (cascade !== null) warnings.push(cascade)
    await tx.provider.delete({ where: { id: p.id } })
  })
  if (warnings.length > 0) logger.warn({ provider: name, warnings }, '[config] provider delete cascaded to chain')
  await syncToConfigFile()
  resetLlmsContext()
  return { warnings }
}

export async function setModelEnabled(providerName: string, modelName: string, enabled: boolean): Promise<void> {
  const prisma = getPrismaClient()
  const model = await prisma.model.findFirst({
    where: { name: modelName, provider: { name: providerName } }
  })
  if (!model) throw new Error(`Model "${modelName}" not found under provider "${providerName}"`)
  const flipped = model.enabled !== enabled
  await prisma.model.update({
    where: { id: model.id },
    data: {
      enabled,
      ...(flipped
        ? { testStatus: ModelTestStatus.unknown, testCheckedAt: null, testPassedAt: null, testError: null }
        : {})
    }
  })
  await syncToConfigFile()
  resetLlmsContext()
}

// Manual tier override for the quota-aware selector. `null` clears the
// override so tierOf(name) name-inference takes over again. Emits a
// llmsContext reset so any in-flight selector state re-reads the
// change on the next request.
export async function setModelManualTier(
  providerName: string,
  modelName: string,
  manualTier: 'fable' | 'opus' | 'sonnet' | 'haiku' | null
): Promise<void> {
  const prisma = getPrismaClient()
  const model = await prisma.model.findFirst({
    where: { name: modelName, provider: { name: providerName } }
  })
  if (!model) throw new Error(`Model "${modelName}" not found under provider "${providerName}"`)
  if (model.manualTier === manualTier) return
  await prisma.model.update({ where: { id: model.id }, data: { manualTier } })
  await syncToConfigFile()
  resetLlmsContext()
}

// Manual reasoning-effort override for OpenAI-style reasoning models.
// `null` clears the override, restoring the vendor default. Consumed at
// unified-request build time in src/llms/request-effort-override.ts.
export async function setModelReasoningEffort(
  providerName: string,
  modelName: string,
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
): Promise<void> {
  const prisma = getPrismaClient()
  const model = await prisma.model.findFirst({
    where: { name: modelName, provider: { name: providerName } }
  })
  if (!model) throw new Error(`Model "${modelName}" not found under provider "${providerName}"`)
  if (model.reasoningEffort === reasoningEffort) return
  await prisma.model.update({ where: { id: model.id }, data: { reasoningEffort } })
  await syncToConfigFile()
  resetLlmsContext()
}

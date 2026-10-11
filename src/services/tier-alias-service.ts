/**
 * Provider tiers: which model a route's "<provider> · <tier>" means.
 *
 * A tier some of the provider's models name (`claude-sonnet-5-5` says
 * sonnet) is derived: it routes to the newest of those that is switched on
 * (`src/shared/tier-resolution.ts`). Nothing picks that model but the
 * operator's switch — a catalog refresh lands new models off, so a release
 * is offered, never routed, until someone turns it on after looking at its
 * price and entitlement.
 *
 * A tier no model names — Codex's `gpt-*`, OpenAI, Gemini — has nothing to
 * derive from, so it keeps the operator's stored alias (`ProviderTierAlias`).
 * A stored alias on a derived tier is left in place but ignored; it is what
 * an older build routes by after a rollback.
 */

import { getPrismaClient } from '../db/client'
import type { Prisma, PrismaClient } from '../generated/prisma/client'
import { type ModelTier, ModelTierSchema } from '../schemas/domain/tier-route'
import { isCodexImageModel } from '../shared/data/subscriptions'
import { namedModelsOf, newerOffOf, resolveTier, type TierResolution } from '../shared/tier-resolution'

// Everything a tier's resolution and its routing view read, in one select
// so the per-request view and the provider page load the same rows.
export const PROVIDER_TIER_SELECT = {
  name: true,
  enabled: true,
  apiBaseUrl: true,
  authMode: true,
  apiStyle: true,
  models: {
    select: {
      id: true,
      name: true,
      enabled: true,
      apiStyle: true,
      contextWindow: true,
      capability: { select: { efforts: true } }
    }
  },
  tierAliases: { select: { tier: true, modelId: true, updatedAt: true } }
} satisfies Prisma.ProviderSelect

export type ProviderTierRow = Prisma.ProviderGetPayload<{ select: typeof PROVIDER_TIER_SELECT }>
export type TierModelRow = ProviderTierRow['models'][number]

export interface ResolvedTier {
  provider: ProviderTierRow
  tier: ModelTier
  resolution: TierResolution<TierModelRow>
  // When the stored alias was last set; null on a tier without one.
  aliasUpdatedAt: Date | null
}

// `provider|tier` → its resolution. Read once per request by the tier
// router and once per page by the editor.
export const aliasKey = (provider: string, tier: ModelTier): string => `${provider}|${tier}`

/** A provider's four tiers, resolved. Pure: the caller loads the row. */
export function resolveProviderTiers(provider: ProviderTierRow): ResolvedTier[] {
  return ModelTierSchema.options.map((tier) => {
    const alias = provider.tierAliases.find((a) => a.tier === tier)
    const aliased = alias === undefined ? undefined : provider.models.find((m) => m.id === alias.modelId)
    return {
      provider,
      tier,
      resolution: resolveTier(provider.models, tier, aliased === undefined ? null : aliased),
      aliasUpdatedAt: alias === undefined ? null : alias.updatedAt
    }
  })
}

/** Every matching provider's tiers, keyed by `aliasKey`. */
export async function loadResolvedTiers(
  prisma: PrismaClient | Prisma.TransactionClient = getPrismaClient(),
  where: Prisma.ProviderWhereInput = {}
): Promise<Map<string, ResolvedTier>> {
  const providers = await prisma.provider.findMany({ where, orderBy: { name: 'asc' }, select: PROVIDER_TIER_SELECT })
  return new Map(providers.flatMap(resolveProviderTiers).map((r) => [aliasKey(r.provider.name, r.tier), r]))
}

export interface AliasCandidate {
  model: string
  enabled: boolean
  // Newer than the routed model and switched off: turning it on moves the
  // route. Only a derived tier has such models.
  isNew: boolean
}

export interface TierAliasRow {
  provider: string
  tier: ModelTier
  // derived: follows the newest switched-on model its name says.
  // manual: the stored alias, because no model names the tier.
  mode: 'derived' | 'manual'
  // The model the tier reaches today, switched on or not; null only on a
  // manual tier with no alias.
  model: string | null
  modelEnabled: boolean
  updatedAt: string | null
  // A derived tier's other named models, newest first. Empty on a manual tier.
  candidates: AliasCandidate[]
}

const aliasRowOf = (r: ResolvedTier): TierAliasRow => {
  const { resolution } = r
  const model = resolution.model
  const newer = new Set(newerOffOf(resolution).map((m) => m.id))
  return {
    provider: r.provider.name,
    tier: r.tier,
    mode: resolution.mode,
    model: model === null ? null : model.name,
    modelEnabled: model === null ? false : model.enabled,
    updatedAt: resolution.mode === 'manual' && r.aliasUpdatedAt !== null ? r.aliasUpdatedAt.toISOString() : null,
    candidates:
      resolution.mode === 'manual'
        ? []
        : resolution.named
            .filter((m) => m.id !== resolution.model.id)
            .map((m) => ({ model: m.name, enabled: m.enabled, isNew: newer.has(m.id) }))
  }
}

/** Every provider's four tiers, resolved, with the candidates for each. */
export async function listTierAliases(prisma: PrismaClient = getPrismaClient()): Promise<TierAliasRow[]> {
  return [...(await loadResolvedTiers(prisma)).values()].map(aliasRowOf)
}

export type SetAliasOutcome =
  | { ok: true; enabledModel: boolean }
  | { ok: false; reason: 'provider-not-found' | 'model-not-found' | 'tier-derived' }

/**
 * Point `provider`'s manual `tier` at `modelName` — the "promote" action.
 *
 * Refused on a derived tier: there the switches decide, and a stored
 * alias would be ignored. The model is switched on in the same
 * transaction: an alias to a model that is off would resolve to nothing,
 * and an operator promoting a model means for it to serve. `enabledModel`
 * says whether that switch flipped, so the caller knows the provider
 * registry has to be rebuilt.
 */
export async function setTierAlias(
  providerName: string,
  tier: ModelTier,
  modelName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<SetAliasOutcome> {
  return prisma.$transaction(async (tx) => {
    const provider = await tx.provider.findUnique({
      where: { name: providerName },
      select: { id: true, models: { select: { name: true, enabled: true } } }
    })
    if (provider === null) return { ok: false, reason: 'provider-not-found' }
    if (namedModelsOf(provider.models, tier).length > 0) return { ok: false, reason: 'tier-derived' }
    const model = await tx.model.findUnique({
      where: { providerId_name: { providerId: provider.id, name: modelName } },
      select: { id: true, enabled: true }
    })
    if (model === null || isCodexImageModel(modelName)) return { ok: false, reason: 'model-not-found' }
    await tx.providerTierAlias.upsert({
      where: { providerId_tier: { providerId: provider.id, tier } },
      create: { providerId: provider.id, tier, modelId: model.id },
      update: { modelId: model.id }
    })
    if (!model.enabled) await tx.model.update({ where: { id: model.id }, data: { enabled: true } })
    return { ok: true, enabledModel: !model.enabled }
  })
}

/**
 * Remove `provider`'s stored alias for `tier`. False when there is none.
 * On a derived tier this only drops a dormant row; routing does not change.
 */
export async function clearTierAlias(
  providerName: string,
  tier: ModelTier,
  prisma: PrismaClient = getPrismaClient()
): Promise<boolean> {
  const provider = await prisma.provider.findUnique({ where: { name: providerName }, select: { id: true } })
  if (provider === null) return false
  const { count } = await prisma.providerTierAlias.deleteMany({ where: { providerId: provider.id, tier } })
  return count > 0
}

/**
 * Each derived tier whose stored alias names another model, as a sentence.
 *
 * Before tiers were derived, the alias was what routed; after an upgrade
 * the newest switched-on named model does. Logged once at boot so an
 * operator can see which routes moved, and switch a model off if a move
 * was not wanted.
 */
export async function derivedTierDrift(prisma: PrismaClient = getPrismaClient()): Promise<string[]> {
  const resolved = await loadResolvedTiers(prisma, { tierAliases: { some: {} } })
  return [...resolved.values()].flatMap((r) => {
    const alias = r.provider.tierAliases.find((a) => a.tier === r.tier)
    if (r.resolution.mode !== 'derived' || alias === undefined || alias.modelId === r.resolution.model.id) return []
    const stored = r.provider.models.find((m) => m.id === alias.modelId)
    const was = stored === undefined ? 'a deleted model' : stored.name
    const now = r.resolution.model.enabled ? r.resolution.model.name : `${r.resolution.model.name} (switched off)`
    return [`${r.provider.name} · ${r.tier} follows ${now}; its stored alias named ${was}`]
  })
}

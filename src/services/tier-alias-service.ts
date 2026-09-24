/**
 * Provider tier aliases: which model a route's "<provider> · <tier>" means.
 *
 * The alias is the one pointer a new model release moves. It never moves
 * by itself. A catalog refresh can discover a model, and this service
 * lists it as a candidate for the tier its name says; pointing the alias
 * at it — "promote" — is an operator's call, because a new model's price,
 * entitlement and behaviour are exactly what someone should look at
 * before every Sonnet request lands on it.
 *
 * A model's tier here is what its name says (`tierOf`), or the manual tier
 * an operator set on it while that column exists. A model that names no
 * family can still be aliased by hand; it just is not offered as a
 * candidate for any tier.
 */

import { getPrismaClient } from '../db/client'
import type { Prisma, PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { tierOf } from '../llms/scenario-router/request-signals'
import { type ModelTier, ModelTierSchema } from '../schemas/domain/tier-route'
import { SUBSCRIPTION_PRESETS } from '../shared/data/subscriptions'

export interface AliasCandidate {
  model: string
  enabled: boolean
  // Appeared after the alias was last set: a model nobody has looked at
  // yet in this role. With no alias set, nothing is "new" — every
  // candidate is simply a choice.
  isNew: boolean
}

export interface TierAliasRow {
  provider: string
  tier: ModelTier
  model: string | null
  updatedAt: string | null
  candidates: AliasCandidate[]
}

// A model's tier as its name says it. Null for a name that says no
// family — such a model is never offered as a candidate, but can still be
// aliased by hand, which is how a Codex or OpenAI provider gets one.
const modelTierOf = (model: { name: string }): ModelTier | null => {
  const inferred = tierOf(model.name)
  return inferred === undefined ? null : inferred
}

/** Every provider's four tier slots, set or not, with the candidates for each. */
export async function listTierAliases(prisma: PrismaClient = getPrismaClient()): Promise<TierAliasRow[]> {
  const providers = await prisma.provider.findMany({
    orderBy: { name: 'asc' },
    select: {
      name: true,
      models: { select: { id: true, name: true, enabled: true, createdAt: true } },
      tierAliases: { select: { tier: true, modelId: true, updatedAt: true } }
    }
  })
  return providers.flatMap((provider) =>
    ModelTierSchema.options.map((tier): TierAliasRow => {
      const alias = provider.tierAliases.find((a) => a.tier === tier)
      const current = alias === undefined ? undefined : provider.models.find((m) => m.id === alias.modelId)
      const candidates = provider.models
        .filter((m) => modelTierOf(m) === tier && m.id !== current?.id)
        // Newest first: the model a refresh just found is the one the
        // operator came to look at.
        .sort((a, b) => b.createdAt.valueOf() - a.createdAt.valueOf() || a.name.localeCompare(b.name))
        .map((m) => ({
          model: m.name,
          enabled: m.enabled,
          isNew: alias !== undefined && m.createdAt > alias.updatedAt
        }))
      return {
        provider: provider.name,
        tier,
        model: current === undefined ? null : current.name,
        updatedAt: alias === undefined ? null : dayjs(alias.updatedAt).toISOString(),
        candidates
      }
    })
  )
}

export type SetAliasOutcome =
  | { ok: true; enabledModel: boolean }
  | { ok: false; reason: 'provider-not-found' | 'model-not-found' }

/**
 * Point `provider`'s `tier` at `modelName` — the "promote" action.
 *
 * The model is switched on in the same transaction: an alias to a model
 * that is off would resolve to nothing, and an operator promoting a model
 * means for it to serve. `enabledModel` says whether that switch flipped,
 * so the caller knows the provider registry has to be rebuilt.
 */
export async function setTierAlias(
  providerName: string,
  tier: ModelTier,
  modelName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<SetAliasOutcome> {
  return prisma.$transaction(async (tx) => {
    const provider = await tx.provider.findUnique({ where: { name: providerName }, select: { id: true } })
    if (provider === null) return { ok: false, reason: 'provider-not-found' }
    const model = await tx.model.findUnique({
      where: { providerId_name: { providerId: provider.id, name: modelName } },
      select: { id: true, enabled: true }
    })
    if (model === null) return { ok: false, reason: 'model-not-found' }
    await tx.providerTierAlias.upsert({
      where: { providerId_tier: { providerId: provider.id, tier } },
      create: { providerId: provider.id, tier, modelId: model.id },
      update: { modelId: model.id }
    })
    if (!model.enabled) await tx.model.update({ where: { id: model.id }, data: { enabled: true } })
    return { ok: true, enabledModel: !model.enabled }
  })
}

/** Unset `provider`'s `tier`. False when the provider has no such alias. */
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
 * Give a subscription provider the aliases its preset implies, where it
 * has none yet.
 *
 * Called in the same transaction that creates the provider's models — on
 * the provider being added and on a catalog refresh — so a freshly
 * connected Claude subscription routes the moment it exists instead of
 * after someone finds the alias strip. The preset's own list decides
 * (`defaultEnabledModels`, most capable first), and only a model whose
 * name says its tier qualifies: Codex names no Claude family, so its
 * aliases stay the operator's to set. An alias that exists is never
 * touched.
 */
export async function ensurePresetAliases(tx: Prisma.TransactionClient, providerId: string): Promise<number> {
  const provider = await tx.provider.findUnique({
    where: { id: providerId },
    select: {
      name: true,
      apiBaseUrl: true,
      models: { select: { id: true, name: true } },
      tierAliases: { select: { tier: true } }
    }
  })
  if (provider === null) return 0
  const preset = SUBSCRIPTION_PRESETS.find((p) => p.id === provider.name || p.apiBaseUrl === provider.apiBaseUrl)
  if (preset === undefined) return 0
  const taken = new Set(provider.tierAliases.map((a) => a.tier))
  const creates = ModelTierSchema.options.flatMap((tier) => {
    if (taken.has(tier)) return []
    const name = preset.defaultEnabledModels.find((m) => tierOf(m) === tier)
    const model = name === undefined ? undefined : provider.models.find((m) => m.name === name)
    return model === undefined ? [] : [{ providerId, tier, modelId: model.id }]
  })
  if (creates.length === 0) return 0
  const { count } = await tx.providerTierAlias.createMany({ data: creates, skipDuplicates: true })
  return count
}

export interface ResolvedAlias {
  provider: string
  tier: ModelTier
  model: string
  // Both switches, kept apart so an editor can say which one is off; a
  // route is only usable when both are on.
  modelEnabled: boolean
  providerEnabled: boolean
}

// `provider|tier` → the alias it resolves to. Read once per request by
// the tier router and once per page by the editor.
export const aliasKey = (provider: string, tier: ModelTier): string => `${provider}|${tier}`

export async function resolveTierAliases(
  prisma: PrismaClient = getPrismaClient()
): Promise<Map<string, ResolvedAlias>> {
  const rows = await prisma.providerTierAlias.findMany({
    select: {
      tier: true,
      provider: { select: { name: true, enabled: true } },
      model: { select: { name: true, enabled: true } }
    }
  })
  const out = new Map<string, ResolvedAlias>()
  for (const row of rows) {
    const tier = ModelTierSchema.safeParse(row.tier)
    // A tier string this build does not know is skipped rather than
    // guessed at: an older or newer build may have written it.
    if (!tier.success) continue
    out.set(aliasKey(row.provider.name, tier.data), {
      provider: row.provider.name,
      tier: tier.data,
      model: row.model.name,
      modelEnabled: row.model.enabled,
      providerEnabled: row.provider.enabled
    })
  }
  return out
}

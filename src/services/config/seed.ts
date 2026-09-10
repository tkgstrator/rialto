/**
 * Database seeding: ensure the default preference profile exists, and
 * top-up the Provider table from the bundled llm-prices snapshot /
 * subscription presets so the UI's Add-Provider dropdown is non-empty
 * out of the box.
 */

import { buildSeedProviders } from '@/shared'
import { isDeprecatedModel, OFFICIAL_VENDOR_PRICES, SUBSCRIPTION_PRESETS } from '@/shared/data'
import { getPrismaClient } from '../../db/client'
import {
  type ApiStyle,
  AuthMode,
  type Model as DbModel,
  type Provider as DbProvider,
  type PrismaClient
} from '../../generated/prisma/client'
import { apiStyleForVendor, modelApiStyleOverride } from './api-style'
import { syncDeprecationFlags, type Tx } from './apply'

// Seed the default preference profile (docs/plan/quota-aware-preference-router.md
// §6.3). Idempotent — upserts by the unique `key = 'live'` discriminator.
// `constraints` stays NULL until the user (or a migration) populates it;
// the schema layer treats missing constraints as "all defaults", so a
// null constraint blob is the safe zero-config starting state.
export async function ensurePreferenceProfile(prisma: PrismaClient = getPrismaClient()): Promise<void> {
  await prisma.routerPreferenceProfile.upsert({
    where: { key: 'live' },
    update: {},
    create: { key: 'live' }
  })
}

// First-run convenience: populate the Provider table from the
// llm-prices snapshot so the UI's Add-Provider dropdown and the catalog
// of available models are non-empty out of the box. api_key is left
// unset (NULL) — the user fills it in from the UI. Behaviour is top-up: any
// seed whose `name` isn't already in the table gets inserted, so a
// partial DB gains the remaining vendors on next boot. Existing rows
// keep their api_key / models; the official vendors' apiBaseUrl is
// reconciled to VENDOR_DEFAULTS in seedScrapedPricesIntoDb.
export interface SeedRow {
  name: string
  apiBaseUrl: string
  authMode: AuthMode
  apiStyle: ApiStyle
  models: string[]
  // Subset of `models` to seed as enabled=true. Only consulted for
  // subscription providers (a Pro/Max plan may not entitle the user to
  // every advertised model, so we seed the rest as opt-in). Undefined
  // means "enable everything" — the api_key path never sets this.
  defaultEnabledModels?: string[]
}

// Context window for a SUBSCRIPTION model (priceSeedService skips
// subscription providers, so it must be set here).
//  - Claude: the docs advertise 1M for Sonnet too, but on the
//    subscription path that 1M needs extra usage the plan doesn't
//    grant — only the flagship 1M-tier ids below serve >200K;
//    everything else is the standard 200K.
//  - codex (and any other non-Claude subscription model): the same as
//    the API — reuse the vendor-official scraped value for that model
//    id (OpenAI sub/API share the window).
// undefined → contextWindow stays null (api_key handled by the scrape).
const SUBSCRIPTION_1M_CLAUDE = new Set(['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-7', 'claude-opus-4-8'])
export const subscriptionContextWindow = (seed: SeedRow, name: string): number | undefined => {
  if (seed.authMode !== AuthMode.subscription) return undefined
  if (name.startsWith('claude-')) return SUBSCRIPTION_1M_CLAUDE.has(name) ? 1_000_000 : 200_000
  const openaiVendor = OFFICIAL_VENDOR_PRICES.openai
  if (!openaiVendor) return undefined
  const entry = openaiVendor[name]
  return entry ? entry.contextWindow : undefined
}

// Which of a subscription seed's models should ship enabled. Undefined
// `defaultEnabledModels` (api_key path) preserves the old "enable
// everything not deprecated" behavior at the caller.
const seedEnabledSet = (seed: SeedRow): Set<string> | null =>
  seed.defaultEnabledModels === undefined ? null : new Set(seed.defaultEnabledModels)

const initialSeedEnabled = (seed: SeedRow, name: string, defaults: Set<string> | null): boolean => {
  if (isDeprecatedModel(name)) return false
  if (seed.authMode !== AuthMode.subscription) return false
  return defaults === null ? true : defaults.has(name)
}

// Insert one brand-new seed provider with all its models.
export async function insertSeedProvider(tx: Tx, seed: SeedRow): Promise<void> {
  const provider = await tx.provider.create({
    data: {
      name: seed.name,
      apiBaseUrl: seed.apiBaseUrl,
      // Unset: the user fills the key in from the UI. NULL (not
      // '') so "no key" is represented consistently end to end.
      apiKey: null,
      authMode: seed.authMode,
      apiStyle: seed.apiStyle
    }
  })
  if (seed.models.length === 0) return
  const defaults = seedEnabledSet(seed)
  await tx.model.createMany({
    data: seed.models.map((name) => ({
      providerId: provider.id,
      name,
      deprecated: isDeprecatedModel(name),
      // Registered != routable. Subscription presets seed their curated
      // default set as enabled (the rest ship disabled so the plan-gated
      // ones don't 4xx by default); api_key vendor catalogs stay off
      // (DB default) until the user enables.
      enabled: initialSeedEnabled(seed, name, defaults),
      contextWindow: subscriptionContextWindow(seed, name),
      apiStyle: modelApiStyleOverride(name)
    }))
  })
}

// Top-up an existing provider with any newly-seeded models, resync the
// deprecation flag, and (for subscription providers) refresh
// contextWindow on already-seeded rows.
export async function topUpSeedProvider(
  tx: Tx,
  seed: SeedRow,
  current: DbProvider & { models: DbModel[] }
): Promise<void> {
  const existingModelNames = new Set(current.models.map((m) => m.name))
  const newModels = seed.models.filter((name) => !existingModelNames.has(name))
  if (newModels.length > 0) {
    const defaults = seedEnabledSet(seed)
    await tx.model.createMany({
      data: newModels.map((name) => ({
        providerId: current.id,
        name,
        deprecated: isDeprecatedModel(name),
        // Widening an existing subscription seed (e.g. we now seed the
        // full availableModels list) must not silently enable models the
        // user hasn't opted in to. Mirror insertSeedProvider: only
        // preset defaults land enabled=true.
        enabled: initialSeedEnabled(seed, name, defaults),
        contextWindow: subscriptionContextWindow(seed, name),
        apiStyle: modelApiStyleOverride(name)
      }))
    })
  }
  // Resync deprecation flag for already-seeded rows so new entries
  // added to DEPRECATED_MODELS on upgrade reach existing DBs.
  await syncDeprecationFlags(tx, current.id, seed.models)
  // Reconcile the provider's request shape. apiStyle is derived from the
  // vendor (apiStyleForVendor) with no runtime fallback, but a row seeded
  // before a rule changed can hold a now-stale value — e.g. codex predating
  // the openai_responses rule keeps openai_chat, so models inheriting the
  // provider style POST chat bodies to the codex backend root and 403. Heal
  // existing rows to the canonical value on boot.
  if (current.apiStyle !== seed.apiStyle) {
    await tx.provider.update({ where: { id: current.id }, data: { apiStyle: seed.apiStyle } })
  }
  // Resync the subscription context window onto already-seeded rows so
  // DBs seeded before the column existed get it too. Group by value so
  // it's a handful of updateManys.
  if (seed.authMode !== AuthMode.subscription) return
  const byCtx = new Map<number, string[]>()
  for (const name of seed.models) {
    const ctx = subscriptionContextWindow(seed, name)
    if (ctx === undefined) continue
    const bucket = byCtx.get(ctx)
    if (bucket) bucket.push(name)
    else byCtx.set(ctx, [name])
  }
  for (const [ctx, names] of byCtx) {
    await tx.model.updateMany({
      where: { providerId: current.id, name: { in: names } },
      data: { contextWindow: ctx }
    })
  }
}

export async function ensureSeedProviders(prisma: PrismaClient = getPrismaClient()): Promise<void> {
  const existing = await prisma.provider.findMany({ include: { models: true } })
  const existingByName = new Map(existing.map((p) => [p.name, p]))

  const apiSeeds: SeedRow[] = buildSeedProviders().map((seed) => ({
    name: seed.name,
    apiBaseUrl: seed.apiBaseUrl,
    authMode: AuthMode.api_key,
    apiStyle: apiStyleForVendor(seed.name),
    models: seed.models
  }))
  const subscriptionSeeds: SeedRow[] = SUBSCRIPTION_PRESETS.map((preset) => ({
    name: preset.id,
    apiBaseUrl: preset.apiBaseUrl,
    authMode: AuthMode.subscription,
    apiStyle: apiStyleForVendor(preset.id),
    // Seed every model the plan advertises (not just the defaults) so
    // the provider editor's toggle list — now driven off provider.models
    // — surfaces the full curated set even before the user runs
    // refresh-models. `defaultEnabledModels` still gates which of those
    // rows land enabled=true.
    models: preset.availableModels,
    defaultEnabledModels: preset.defaultEnabledModels
  }))
  const allSeeds = [...apiSeeds, ...subscriptionSeeds]

  await prisma.$transaction(async (tx) => {
    for (const seed of allSeeds) {
      const current = existingByName.get(seed.name)
      if (current) {
        await topUpSeedProvider(tx, seed, current)
      } else {
        await insertSeedProvider(tx, seed)
      }
    }
  })
}

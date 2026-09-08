/**
 * The routable (provider, model) pairs the demo data is built around.
 *
 * The seed prefers whatever the database already has: on a working
 * install the Providers screen is full of the operator's real vendors,
 * and inventing parallel fake ones would just make that screen lie. Only
 * when nothing is routable at all — a fresh database, before any vendor
 * has been connected — does it fall back to registering the bundled
 * catalog's vendors so the other four screens have something to point at.
 */

import { ApiStyle, AuthMode, type PrismaClient } from '../../src/generated/prisma/client'

export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku'

export interface DemoTarget {
  modelId: string
  providerName: string
  modelName: string
  /** The "providerName,modelName" reference every routing store speaks. */
  ref: string
  subscription: boolean
  tier: Tier | null
  contextWindow: number | null
  inputPer1M: number | null
}

// Same substring rule the router uses (scenario-router/model-selection.ts's
// tierOf), duplicated here so the seed does not import the request path.
const inferTier = (modelName: string): Tier | null => {
  const lower = modelName.toLowerCase()
  if (lower.includes('fable')) return 'fable'
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return null
}

interface FallbackModel {
  name: string
  inputPer1M: number | null
  outputPer1M: number | null
  cachedInputPer1M: number | null
  contextWindow: number
}

interface FallbackVendor {
  name: string
  apiBaseUrl: string
  authMode: AuthMode
  apiStyle: ApiStyle
  models: FallbackModel[]
}

// Mirrors the shipped catalog (src/shared/data) closely enough that a
// later "Sync models" reconciles rather than duplicates: the provider
// names and base URLs are the real ones, so the rows are upgraded in
// place instead of sitting beside the real thing.
const FALLBACK_VENDORS: FallbackVendor[] = [
  {
    name: 'claude-code',
    apiBaseUrl: 'https://api.anthropic.com/v1/messages',
    authMode: AuthMode.subscription,
    apiStyle: ApiStyle.anthropic,
    models: [
      { name: 'claude-fable-5-1', inputPer1M: 10, outputPer1M: 50, cachedInputPer1M: 0.25, contextWindow: 1_000_000 },
      { name: 'claude-opus-5', inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5, contextWindow: 1_000_000 },
      { name: 'claude-sonnet-5', inputPer1M: 2, outputPer1M: 10, cachedInputPer1M: 0.2, contextWindow: 1_000_000 },
      { name: 'claude-haiku-4-5', inputPer1M: 1, outputPer1M: 5, cachedInputPer1M: 0.1, contextWindow: 200_000 }
    ]
  },
  {
    name: 'openai',
    apiBaseUrl: 'https://api.openai.com/v1/chat/completions',
    authMode: AuthMode.api_key,
    apiStyle: ApiStyle.openai_chat,
    models: [
      { name: 'gpt-5.6-luna', inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02, contextWindow: 1_050_000 },
      { name: 'gpt-5.6-terra', inputPer1M: 2, outputPer1M: 12, cachedInputPer1M: 0.2, contextWindow: 1_050_000 },
      { name: 'gpt-5.6-sol', inputPer1M: 4, outputPer1M: 20, cachedInputPer1M: 0.4, contextWindow: 1_050_000 },
      { name: 'gpt-6-astra', inputPer1M: 10, outputPer1M: 50, cachedInputPer1M: 1, contextWindow: 1_050_000 }
    ]
  },
  {
    name: 'google',
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/',
    authMode: AuthMode.api_key,
    apiStyle: ApiStyle.gemini,
    models: [
      { name: 'gemini-3.7-flash', inputPer1M: 0.75, outputPer1M: 3.75, cachedInputPer1M: null, contextWindow: 1_048_576 },
      {
        name: 'gemini-3.5-flash-lite',
        inputPer1M: 0.3,
        outputPer1M: 2.5,
        cachedInputPer1M: null,
        contextWindow: 1_048_576
      }
    ]
  }
]

async function registerFallbackVendors(prisma: PrismaClient): Promise<void> {
  for (const vendor of FALLBACK_VENDORS) {
    const provider = await prisma.provider.upsert({
      where: { name: vendor.name },
      // An existing provider keeps its credentials and base URL; only the
      // enabled switch is forced, because a disabled provider is exactly
      // the state that left us with nothing routable.
      update: { enabled: true },
      create: {
        name: vendor.name,
        apiBaseUrl: vendor.apiBaseUrl,
        apiKey: null,
        authMode: vendor.authMode,
        apiStyle: vendor.apiStyle,
        enabled: true
      }
    })
    for (const model of vendor.models) {
      await prisma.model.upsert({
        where: { providerId_name: { providerId: provider.id, name: model.name } },
        update: { enabled: true },
        create: {
          providerId: provider.id,
          name: model.name,
          enabled: true,
          inputPer1M: model.inputPer1M,
          outputPer1M: model.outputPer1M,
          cachedInputPer1M: model.cachedInputPer1M,
          contextWindow: model.contextWindow
        }
      })
    }
  }
}

async function loadTargets(prisma: PrismaClient): Promise<DemoTarget[]> {
  const rows = await prisma.model.findMany({
    where: { enabled: true, provider: { enabled: true } },
    include: { provider: { select: { name: true, authMode: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }]
  })
  return rows.map((row) => ({
    modelId: row.id,
    providerName: row.provider.name,
    modelName: row.name,
    ref: `${row.provider.name},${row.name}`,
    subscription: row.provider.authMode === AuthMode.subscription,
    tier: row.manualTier === 'fable' || row.manualTier === 'opus' || row.manualTier === 'sonnet' || row.manualTier === 'haiku' ? row.manualTier : inferTier(row.name),
    contextWindow: row.contextWindow,
    inputPer1M: row.inputPer1M
  }))
}

export interface TargetsResult {
  targets: DemoTarget[]
  /** True when the fallback catalog had to be registered first. */
  registeredVendors: boolean
}

export async function resolveTargets(prisma: PrismaClient): Promise<TargetsResult> {
  const existing = await loadTargets(prisma)
  if (existing.length > 0) return { targets: existing, registeredVendors: false }
  await registerFallbackVendors(prisma)
  return { targets: await loadTargets(prisma), registeredVendors: true }
}

/**
 * Pick targets by name preference, then pad with whatever is left.
 *
 * The chains below are written against the models this repo ships with,
 * but the seed has to survive a database holding a completely different
 * set — so a preference that matches nothing is skipped rather than
 * fatal, and the chain is topped up in catalog order.
 */
export function pickChain(targets: DemoTarget[], preferences: string[], length: number): DemoTarget[] {
  const matched = preferences
    .map((pref) => targets.find((t) => t.modelName.toLowerCase().includes(pref.toLowerCase())))
    .filter((t): t is DemoTarget => t !== undefined)
  const deduped = matched.filter((t, idx) => matched.findIndex((o) => o.ref === t.ref) === idx)
  const padding = targets.filter((t) => !deduped.some((d) => d.ref === t.ref))
  return [...deduped, ...padding].slice(0, Math.min(length, targets.length))
}

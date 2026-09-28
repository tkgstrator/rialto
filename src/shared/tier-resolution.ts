/**
 * Which model a provider's tier routes to.
 *
 * A tier is derived when some of the provider's models say it in their
 * name: it routes to the newest of those that is switched on. Switching a
 * model on or off is the whole decision — a refresh lands new models off,
 * so a release never moves a route until an operator turns it on. Only a
 * tier no model names (Codex's `gpt-*`, OpenAI, Gemini) falls back to the
 * operator's stored alias, because nothing in a name can say it.
 *
 * Browser-safe and shared: the server routes by it and the provider page
 * previews a draft with it, so the two cannot disagree.
 */

import type { RequestedModelTier } from '@/schemas/domain/router'
import { isCodexImageModel } from './data/subscriptions'
import { tierOf } from './model-tier'
import { newestFirst } from './model-version'

export interface TierModel {
  name: string
  enabled: boolean
}

/** The models whose name says `tier`, newest first. Image models serve no tier. */
export function namedModelsOf<M extends TierModel>(models: readonly M[], tier: RequestedModelTier): M[] {
  return models
    .filter((m) => !isCodexImageModel(m.name) && tierOf(m.name) === tier)
    .sort((a, b) => newestFirst(a.name, b.name))
}

export type TierResolution<M> =
  // `model` is the newest switched-on named model, or — none being on —
  // the newest named one, which routing then skips as switched off.
  | { mode: 'derived'; model: M; named: M[] }
  // No model names the tier: the stored alias, or nothing.
  | { mode: 'manual'; model: M | null }

export function resolveTier<M extends TierModel>(
  models: readonly M[],
  tier: RequestedModelTier,
  alias: M | null
): TierResolution<M> {
  const named = namedModelsOf(models, tier)
  const [newest] = named
  if (newest === undefined) return { mode: 'manual', model: alias }
  const on = named.find((m) => m.enabled)
  return { mode: 'derived', model: on === undefined ? newest : on, named }
}

/**
 * The named models newer than the routed one — all switched off, since the
 * routed one is the newest that is on. Switching one on moves the route.
 */
export function newerOffOf<M extends TierModel>(resolution: TierResolution<M>): M[] {
  if (resolution.mode === 'manual') return []
  return resolution.named.slice(0, resolution.named.indexOf(resolution.model))
}

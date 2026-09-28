/**
 * What a model or provider deletion takes out of the scenario routes.
 *
 * Both cascade in the database: a deleted model takes the tier aliases
 * that named it and moves any derived tier it served, a deleted provider
 * takes its aliases and every route that named it. Nothing can be
 * preserved — the target is gone — but the operator should hear what
 * happened and where. Worked out BEFORE the delete; afterwards there is
 * nothing left to compare.
 */

import { PROVIDER_TIER_SELECT, type ProviderTierRow, resolveProviderTiers } from '../../tier-alias-service'
import type { Tx } from '../apply'

const tally = (labels: readonly string[]): string => {
  const counts = new Map<string, number>()
  for (const label of labels) {
    const seen = counts.get(label)
    counts.set(label, seen === undefined ? 1 : seen + 1)
  }
  return [...counts.entries()].map(([label, n]) => (n === 1 ? label : `${label} ×${n}`)).join(', ')
}

/**
 * The tiers a model deletion changes, or null when none routes to a
 * removed model.
 *
 * A manual tier whose alias named a removed model is unset, and routes
 * through it are skipped until an alias is set again. A derived tier moves
 * on to the next newest switched-on model its name says — or to nothing —
 * so the warning names where each one went.
 */
export async function tierCascadeWarning(
  tx: Tx,
  providerId: string,
  removed: readonly string[],
  subject: string
): Promise<string | null> {
  const provider = await tx.provider.findUnique({ where: { id: providerId }, select: PROVIDER_TIER_SELECT })
  if (provider === null) return null
  const gone = new Set(removed)
  const goneIds = new Set(provider.models.filter((m) => gone.has(m.name)).map((m) => m.id))
  const after: ProviderTierRow = {
    ...provider,
    models: provider.models.filter((m) => !goneIds.has(m.id)),
    tierAliases: provider.tierAliases.filter((a) => !goneIds.has(a.modelId))
  }
  const later = new Map(resolveProviderTiers(after).map((r) => [r.tier, r.resolution.model]))
  const hit = resolveProviderTiers(provider).filter(
    (r) => r.resolution.model !== null && gone.has(r.resolution.model.name)
  )
  const unset = hit.filter((r) => r.resolution.mode === 'manual').map((r) => `${provider.name} · ${r.tier}`)
  const moved = hit
    .filter((r) => r.resolution.mode === 'derived')
    .map((r) => {
      const next = later.get(r.tier)
      const to = next === undefined || next === null ? 'nothing' : next.enabled ? next.name : `${next.name} (off)`
      return `${provider.name} · ${r.tier} → ${to}`
    })
  const sentences = [
    ...(unset.length === 0
      ? []
      : [
          `Unset ${unset.length} ${unset.length === 1 ? 'tier alias' : 'tier aliases'} naming ${subject}: ${tally(unset)}. Routes through them are skipped until an alias is set again.`
        ]),
    ...(moved.length === 0
      ? []
      : [`Moved ${moved.length} ${moved.length === 1 ? 'tier' : 'tiers'} off ${subject}: ${moved.join(', ')}.`])
  ]
  return sentences.length === 0 ? null : sentences.join(' ')
}

/** The tier-map routes a provider deletion removes, or null when no profile names the provider. */
export async function routeCascadeWarning(tx: Tx, providerId: string, subject: string): Promise<string | null> {
  const rows = await tx.tierRoute.findMany({
    where: { providerId },
    select: { scenario: true, lane: true, profile: { select: { key: true } } }
  })
  if (rows.length === 0) return null
  const noun = rows.length === 1 ? 'tier route' : 'tier routes'
  const where = tally(rows.map((r) => `${r.profile.key}/${r.scenario}/${r.lane}`))
  return `Removed ${rows.length} ${noun} naming ${subject}: ${where}.`
}

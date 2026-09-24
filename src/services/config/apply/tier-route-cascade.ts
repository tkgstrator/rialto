/**
 * What a model or provider deletion takes out of the scenario routes.
 *
 * Both cascade in the database: a deleted model takes the tier aliases
 * that named it, a deleted provider takes its aliases and every route that
 * named it. Nothing can be preserved — the target is gone — but the
 * operator should hear what happened and where. Counted BEFORE the delete;
 * afterwards there is nothing left to count.
 */

import type { Prisma } from '../../../generated/prisma/client'
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
 * The tier aliases a model deletion unsets, or null when none names the
 * models matching `models`. A route through an unset alias is skipped until
 * one is set, so the warning says which provider tiers went dark.
 */
export async function aliasCascadeWarning(
  tx: Tx,
  models: Prisma.ModelWhereInput,
  subject: string
): Promise<string | null> {
  const rows = await tx.providerTierAlias.findMany({
    where: { model: models },
    select: { tier: true, provider: { select: { name: true } } }
  })
  if (rows.length === 0) return null
  const noun = rows.length === 1 ? 'tier alias' : 'tier aliases'
  const which = tally(rows.map((r) => `${r.provider.name} · ${r.tier}`))
  return `Unset ${rows.length} ${noun} naming ${subject}: ${which}. Routes through them are skipped until an alias is set again.`
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

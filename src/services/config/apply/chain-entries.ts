/**
 * The chain entries a model or provider deletion takes with it.
 *
 * `RouterPreferenceEntry.model` cascades on delete, so removing a model
 * silently shortens every chain that named it. Nothing can be preserved
 * — the target is gone — but the operator should hear that it happened
 * and where: which profile, which scenario, which lane.
 */

import type { Prisma } from '../../../generated/prisma/client'
import type { Tx } from '../apply'

/**
 * A warning naming the entries about to cascade away with the models
 * matching `models`, or null when no chain names any of them. Counted
 * BEFORE the delete — afterwards there is nothing left to count.
 */
export async function chainEntryCascadeWarning(
  tx: Tx,
  models: Prisma.ModelWhereInput,
  subject: string
): Promise<string | null> {
  const rows = await tx.routerPreferenceEntry.findMany({
    where: { model: models },
    select: { scenario: true, kind: true, profile: { select: { key: true } } }
  })
  if (rows.length === 0) return null
  const perLane = new Map<string, number>()
  for (const row of rows) {
    const lane = `${row.profile.key}/${row.scenario}/${row.kind}`
    const seen = perLane.get(lane)
    perLane.set(lane, seen === undefined ? 1 : seen + 1)
  }
  const detail = [...perLane.entries()].map(([lane, n]) => (n === 1 ? lane : `${lane} ×${n}`)).join(', ')
  const noun = rows.length === 1 ? 'chain entry' : 'chain entries'
  return `Removed ${rows.length} ${noun} naming ${subject}: ${detail}.`
}

/**
 * One-shot conversion of every profile's old chain into scenario routes.
 *
 * Runs from `db seed`, which the container entrypoint calls after
 * `migrate deploy` on every start. `RouterPreferenceProfile.chainBackfilledAt`
 * makes it once per profile; a profile that already has tier routes (an
 * operator got there first) is only marked.
 *
 * A failure is not swallowed. Each profile converts in its own
 * transaction, so the profiles before a failure stay converted and marked,
 * and the failing one keeps its old chain untouched — but the error
 * propagates, the seed exits non-zero, and `set -e` in the entrypoint
 * stops the container. The alternative, logging and carrying on, would
 * start the new build with that profile silently empty: every request on
 * it passed through as sent.
 *
 * `live` goes first so the default profile claims the aliases, and other
 * profiles resolve through them.
 */

import { getPrismaClient } from '../../db/client'
import type { PrismaClient } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import { ROUTING_LANES, ROUTING_SCENARIOS } from '../../schemas/domain/tier-route'
import { DEFAULT_PROFILE_KEY } from '../tier-route-service'
import { type ConvertedLane, type ExistingAlias, planTierRoutes } from './plan-tier-routes'

export interface BackfillReport {
  profile: string
  outcome: 'converted' | 'already-routed'
  aliases: number
  routes: number
  notes: string[]
}

type EntryRow = {
  scenario: string
  kind: string
  priority: number
  enabled: boolean
  model: {
    id: string
    name: string
    manualTier: string | null
    deprecated: boolean
    enabled: boolean
    provider: { id: string; name: string; enabled: boolean }
  }
}

// The chain's entries as the planner's lists, the default agent list
// first so its models get the providers' slots; the web search and image
// lists are only counted.
function lanesOf(entries: readonly EntryRow[]): {
  lanes: ConvertedLane[]
  ignoredLanes: { lane: string; count: number }[]
} {
  const toInput = (e: EntryRow) => ({
    priority: e.priority,
    enabled: e.enabled,
    model: {
      id: e.model.id,
      name: e.model.name,
      manualTier: e.model.manualTier,
      deprecated: e.model.deprecated,
      enabled: e.model.enabled
    },
    provider: e.model.provider
  })
  const lanes: ConvertedLane[] = ROUTING_SCENARIOS.flatMap((scenario) =>
    ROUTING_LANES.map((lane) => ({
      scenario,
      lane,
      entries: entries.filter((e) => e.scenario === scenario && e.kind === lane).map(toInput)
    }))
  )
  const converted = new Set(lanes.map((l) => `${l.scenario}/${l.lane}`))
  const ignored = new Map<string, number>()
  for (const e of entries) {
    const lane = `${e.scenario}/${e.kind}`
    if (converted.has(lane)) continue
    const seen = ignored.get(lane)
    ignored.set(lane, seen === undefined ? 1 : seen + 1)
  }
  return { lanes, ignoredLanes: [...ignored].map(([lane, count]) => ({ lane, count })) }
}

export async function backfillTierRoutes(prisma: PrismaClient = getPrismaClient()): Promise<BackfillReport[]> {
  const pending = await prisma.routerPreferenceProfile.findMany({
    where: { chainBackfilledAt: null },
    select: { id: true, key: true }
  })
  const ordered = [...pending].sort((a, b) =>
    a.key === DEFAULT_PROFILE_KEY ? -1 : b.key === DEFAULT_PROFILE_KEY ? 1 : a.key.localeCompare(b.key)
  )

  const reports: BackfillReport[] = []
  for (const profile of ordered) {
    const report = await prisma.$transaction(async (tx): Promise<BackfillReport> => {
      const mark = () =>
        tx.routerPreferenceProfile.update({ where: { id: profile.id }, data: { chainBackfilledAt: dayjs().toDate() } })

      if ((await tx.tierRoute.count({ where: { profileId: profile.id } })) > 0) {
        await mark()
        return { profile: profile.key, outcome: 'already-routed', aliases: 0, routes: 0, notes: [] }
      }

      const [entries, aliasRows] = await Promise.all([
        tx.routerPreferenceEntry.findMany({
          where: { profileId: profile.id },
          orderBy: { priority: 'asc' },
          select: {
            scenario: true,
            kind: true,
            priority: true,
            enabled: true,
            model: {
              select: {
                id: true,
                name: true,
                manualTier: true,
                deprecated: true,
                enabled: true,
                provider: { select: { id: true, name: true, enabled: true } }
              }
            }
          }
        }),
        tx.providerTierAlias.findMany({
          select: { providerId: true, tier: true, modelId: true, model: { select: { name: true } } }
        })
      ])

      const aliases = new Map<string, ExistingAlias>(
        aliasRows.map((a) => [`${a.providerId}|${a.tier}`, { modelId: a.modelId, modelName: a.model.name }])
      )
      const { lanes, ignoredLanes } = lanesOf(entries)
      const plan = planTierRoutes({ lanes, aliases, ignoredLanes })

      if (plan.aliases.length > 0) await tx.providerTierAlias.createMany({ data: plan.aliases, skipDuplicates: true })
      if (plan.routes.length > 0) {
        await tx.tierRoute.createMany({ data: plan.routes.map((r) => ({ ...r, profileId: profile.id })) })
      }
      await mark()
      return {
        profile: profile.key,
        outcome: 'converted',
        aliases: plan.aliases.length,
        routes: plan.routes.length,
        notes: plan.notes
      }
    })
    if (report.outcome === 'converted') {
      logger.info(
        { profile: report.profile, aliases: report.aliases, routes: report.routes, notes: report.notes },
        '[tier-routes] converted the chain into scenario routes'
      )
    }
    reports.push(report)
  }
  return reports
}

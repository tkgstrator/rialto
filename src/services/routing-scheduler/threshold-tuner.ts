/**
 * Tunes each profile's Long context threshold by how the Long context
 * route's quota is going.
 *
 * Long context is where an operator puts the model they most want used —
 * Fable, on most installs — and the threshold decides how much traffic
 * reaches it. So when that route is on pace to end its window with quota
 * left over, the threshold comes down and more requests qualify; when it
 * is on pace to run out, the threshold goes up and fewer do.
 *
 * The guards are the ones the utilization-tuning plan set out, because an
 * automatic change that is wrong costs quietly:
 *
 *   - at most one change a day per profile, 20% at a time;
 *   - never below 30k (ordinary coding turns would all be Long context)
 *     and never above the automatic base (a prompt that big would not fit
 *     the Default model it is being kept on);
 *   - no change without a pace reading — a window too little elapsed to
 *     judge, or no reading at all, leaves the value alone;
 *   - a lowering the route cannot carry — it runs out within the day — is
 *     rolled back to the value before it;
 *   - `constraints.autoTuneLongContext` turns it off.
 *
 * Every change is logged. `tuneThreshold` decides and is pure;
 * `tuneLongContextThresholds` reads the profiles and writes the result.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { PACE_OVER_PCT, PACE_SURPLUS_PCT } from '../../llms/tier-router/select'
import { LONG_CONTEXT_FLOOR, longContextBase } from '../../llms/tier-router/threshold'
import { logger } from '../../logger'
import { JsonObjectSchema } from '../../schemas/domain/preset'
import { defaultAgentWindowOf, isUsableRoute, loadTierProfileView } from '../tier-route-service'
import type { RoutingSnapshot } from './types'

export const TUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const TUNE_STEP = 0.2

export interface TuneInput {
  // The threshold in effect and the automatic base it may not exceed.
  current: number
  base: number
  // The tuner's own state.
  stored: number | null
  previous: number | null
  tunedAt: number | null
  now: number
  // The snapshot's reading of the first usable Long context · agent route.
  target: { projectedPct: number | null; exhausted: boolean } | undefined
}

export interface TuneDecision {
  threshold: number
  previous: number | null
  reason: 'lowered' | 'raised' | 'rolled back'
}

export function tuneThreshold(input: TuneInput): TuneDecision | null {
  const { current, base, stored, previous, tunedAt, now, target } = input
  if (target === undefined) return null
  const recent = tunedAt !== null && now - tunedAt < TUNE_INTERVAL_MS
  // The last change lowered the threshold and the route ran out since:
  // more traffic than it could carry. Put it back.
  if (recent && target.exhausted && stored !== null && previous !== null && previous > stored) {
    return { threshold: previous, previous: null, reason: 'rolled back' }
  }
  if (recent || target.projectedPct === null) return null
  const floor = Math.min(LONG_CONTEXT_FLOOR, base)
  if (target.projectedPct < PACE_SURPLUS_PCT) {
    const next = Math.max(floor, Math.round(current * (1 - TUNE_STEP)))
    return next < current ? { threshold: next, previous: current, reason: 'lowered' } : null
  }
  if (target.projectedPct > PACE_OVER_PCT) {
    const next = Math.min(base, Math.round(current * (1 + TUNE_STEP)))
    return next > current ? { threshold: next, previous: current, reason: 'raised' } : null
  }
  return null
}

type ProfileRow = { id: string; key: string; constraints: Prisma.JsonValue }

// One profile: decide, and write the decision when there is one.
async function tuneProfile(prisma: PrismaClient, profile: ProfileRow, snapshot: RoutingSnapshot, now: number) {
  const view = await loadTierProfileView(profile.key, prisma)
  if (!view.constraints.autoTuneLongContext) return
  const first = view.routes.longContext.agent.find(isUsableRoute)
  if (first === undefined || first.resolved === null) return
  const target = snapshot.targets.get(`${first.provider},${first.resolved.model}`)
  const tunedAt = view.constraints.longContextTunedAt
  const decision = tuneThreshold({
    current: view.longContextThreshold,
    // Recomputed, not stored: it follows the Default route's alias.
    base: longContextBase(defaultAgentWindowOf(view.routes)),
    stored: view.constraints.longContextThreshold,
    previous: view.constraints.previousLongContextThreshold,
    tunedAt: tunedAt === null ? null : dayjs(tunedAt).valueOf(),
    now,
    target: target === undefined ? undefined : { projectedPct: target.projectedPct, exhausted: target.exhausted }
  })
  if (decision === null) return
  const blob = JsonObjectSchema.safeParse(profile.constraints === null ? {} : profile.constraints)
  await prisma.routerPreferenceProfile.update({
    where: { id: profile.id },
    data: {
      constraints: {
        ...(blob.success ? blob.data : {}),
        longContextThreshold: decision.threshold,
        previousLongContextThreshold: decision.previous,
        longContextTunedAt: dayjs(now).toISOString()
      }
    }
  })
  logger.info(
    {
      profile: profile.key,
      from: view.longContextThreshold,
      to: decision.threshold,
      reason: decision.reason,
      projectedPct: target === undefined ? null : target.projectedPct
    },
    '[routing-scheduler] Long context threshold tuned'
  )
}

/**
 * One pass over every profile with a Long context list. Never throws: a
 * failure is logged and the tick that called it carries on — the
 * threshold simply stays where it was until the next pass.
 */
export async function tuneLongContextThresholds(
  prisma: PrismaClient,
  snapshot: RoutingSnapshot,
  now: number
): Promise<void> {
  try {
    const profiles = await prisma.routerPreferenceProfile.findMany({
      where: { tierRoutes: { some: { scenario: 'longContext' } } },
      select: { id: true, key: true, constraints: true }
    })
    for (const profile of profiles) await tuneProfile(prisma, profile, snapshot, now)
  } catch (err) {
    logger.warn({ err }, '[routing-scheduler] Long context tuning failed — thresholds left as they were')
  }
}

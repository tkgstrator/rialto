import type { Logger } from 'pino'
import { getPrismaClient } from '@/db/client'
import { Prisma } from '@/generated/prisma/client'
import { logger } from '@/logger'
import type { RoutingDecisionObservation } from '@/schemas/domain/routing-decision'

export type RoutingDecisionWriter = (reqId: string, observation: RoutingDecisionObservation) => Promise<void>

async function writeRoutingDecision(reqId: string, observation: RoutingDecisionObservation): Promise<void> {
  await getPrismaClient().routingDecision.create({
    data: {
      reqId,
      ...observation,
      probabilities: observation.probabilities === null ? Prisma.DbNull : observation.probabilities
    }
  })
}

export async function recordRoutingDecision(
  reqId: string,
  observation: RoutingDecisionObservation,
  env: Record<string, string | undefined> = process.env,
  log: Pick<Logger, 'warn'> = logger,
  write: RoutingDecisionWriter = writeRoutingDecision
): Promise<void> {
  // Respect the existing request-capture opt-out before acquiring a DB client.
  if (env.CAPTURE_REQUESTS === 'false') return
  try {
    await write(reqId, observation)
  } catch {
    // A missing migration, unavailable DB or sensitive driver error must never
    // change routing or leak the serialized classifier input into file logs.
    log.warn(
      { event: 'routing_decision_capture', reqId, reason: 'database_error' },
      '[routing] decision capture failed'
    )
  }
}

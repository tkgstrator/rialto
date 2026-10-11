import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import type { RoutingDecisionObservation } from '../../src/schemas/domain/routing-decision'
import { recordRoutingDecision } from '../../src/services/routing-decision-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const observation: RoutingDecisionObservation = {
  requestBody:
    '{"model":"jeff-latest","state":{"requested_model":"caller-model-識別子"},"questions":{"route":{"instructions":"Choose the lowest capability tier that can reliably serve this request."}}}',
  outcome: 'success',
  reason: 'accepted',
  predictedTier: 'opus',
  confidence: 0.94,
  probabilities: { opus: 0.955, sonnet: 0.045 },
  chosenProbability: 0.955,
  decisionAccepted: true,
  minConfidence: 0.9,
  durationMs: 15,
  httpStatus: 200,
  expectedTier: null,
  evaluationStatus: 'unrated'
}

describe.skipIf(!HAS_DB)('routing decision archive', () => {
  beforeEach(resetDbTables)
  afterAll(async () => {
    await resetDbTables()
    await teardownPrisma()
  })

  test('persists the exact body and normalized result without requiring session or usage rows', async () => {
    await recordRoutingDecision('request-1', observation, {})
    const rows = await getPrismaClient().routingDecision.findMany({ where: { reqId: 'request-1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reqId: 'request-1', ...observation })
    expect(rows[0].createdAt).toBeDefined()
    expect(await getPrismaClient().session.count()).toBe(0)
    expect(await getPrismaClient().requestLog.count()).toBe(0)
  })

  test('failure and missing distributions retain null rather than fabricated predictions', async () => {
    const failed: RoutingDecisionObservation = {
      ...observation,
      outcome: 'fallback',
      reason: 'network_error',
      predictedTier: null,
      confidence: null,
      probabilities: null,
      chosenProbability: null,
      decisionAccepted: false,
      httpStatus: null
    }
    await recordRoutingDecision('failed-request', failed, {})
    expect(await getPrismaClient().routingDecision.findFirst({ where: { reqId: 'failed-request' } })).toMatchObject({
      reqId: 'failed-request',
      ...failed
    })
  })

  test('existing capture opt-out does not create an archive row', async () => {
    await recordRoutingDecision('disabled-request', observation, { CAPTURE_REQUESTS: 'false' })
    expect(await getPrismaClient().routingDecision.count()).toBe(0)
  })
})

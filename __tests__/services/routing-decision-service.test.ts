import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import type { RoutingDecisionObservation } from '../../src/schemas/domain/routing-decision'
import { recordRoutingDecision } from '../../src/services/routing-decision-service'

const observation: RoutingDecisionObservation = {
  requestBody: JSON.stringify({ model: 'jeff-latest', state: { requested_model: 'caller-model-識別子' } }),
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

const captureLog = () => {
  const logs: string[] = []
  const log = pino({}, { write: (line: string) => logs.push(line) })
  return { logs, log }
}

describe('routing decision persistence', () => {
  test('request capture is enabled by default and writes the exact observation and explicit request id', async () => {
    const writes: Array<{ reqId: string; row: RoutingDecisionObservation }> = []
    const { logs, log } = captureLog()
    await recordRoutingDecision('request-1', observation, {}, log, async (reqId, row) => {
      writes.push({ reqId, row })
    })
    expect(writes).toEqual([{ reqId: 'request-1', row: observation }])
    expect(logs).toHaveLength(0)
  })

  test('CAPTURE_REQUESTS=false prevents even writer acquisition', async () => {
    const { log, logs } = captureLog()
    const calls: string[] = []
    await recordRoutingDecision('request-1', observation, { CAPTURE_REQUESTS: 'false' }, log, async () => {
      calls.push('called')
      throw new Error('writer should not run')
    })
    expect(calls).toHaveLength(0)
    expect(logs).toHaveLength(0)
  })

  test('database write failures are fail-open and warnings contain only allowlisted metadata', async () => {
    const { log, logs } = captureLog()
    await expect(
      recordRoutingDecision('request-1', observation, {}, log, async () => {
        throw new Error(`sensitive-db-error ${observation.requestBody}`)
      })
    ).resolves.toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0])).toMatchObject({
      event: 'routing_decision_capture',
      reqId: 'request-1',
      reason: 'database_error'
    })
    expect(logs.join('')).not.toContain('sensitive-db-error')
    expect(logs.join('')).not.toContain('requested_model')
    expect(logs.join('')).not.toContain('requestBody')
  })

  test('runtime archives with the explicit request id rather than logger bindings', () => {
    // Isolate the DB module mock so other suites retain their real client.
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `import { mock } from 'bun:test'
         const saved = Promise.withResolvers()
         mock.module('./src/db/client', () => ({getPrismaClient: () => ({routingDecision: {create: async ({data}) => {saved.resolve(data); return data}}})}))
         const pino = (await import('pino')).default
         const {routeByScenario, __setTierProfilesForTests} = await import('./src/llms/tier-router/runtime')
         const {mapWith, route} = await import('./__tests__/llms/tier-fixture')
         __setTierProfilesForTests({live: mapWith({default: {agent: [route('provider', 'opus', 'opus-model'), route('provider', 'sonnet', 'sonnet-model')]}}, {decisionEnabled: true, decisionApiBaseUrl: 'https://decision.example', decisionModel: 'jeff-latest'})})
         const lines = []
         const log = pino({}, {write: line => lines.push(line)}).child({reqId: 'logger-only-id'})
         globalThis.fetch = async () => new Response(JSON.stringify({answers: {route: {choice: 'opus', confidence: 0.94}}}))
         const routed = await routeByScenario({profileKey: 'live', requestedModel: 'caller-model-識別子', requestTokenCount: 1000, thinking: false, isSubagent: false, needsWebSearch: false, hasTools: false}, log, 'explicit-request-id')
         const data = await saved.promise
         console.log(JSON.stringify({data, primary: routed.selection.primary, lines: lines.map(line => JSON.parse(line))}))`
      ],
      cwd: process.cwd(),
      env: { ...process.env, CAPTURE_REQUESTS: 'true', DATABASE_URL: '', TEST_DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5000
    })
    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout.toString())
    expect(output.data.reqId).toBe('explicit-request-id')
    expect(output.primary).toBe('provider,opus-model')
    expect(JSON.parse(output.data.requestBody).state.requested_model).toBe('caller-model-識別子')
    expect(output.data).toMatchObject({ expectedTier: null, evaluationStatus: 'unrated', httpStatus: 200 })
    expect(JSON.stringify(output.lines)).not.toContain('caller-model-識別子')
  })

  test('a missing DATABASE_URL is safely caught by the real writer', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `delete process.env.DATABASE_URL
         const pino = (await import('pino')).default
         const { recordRoutingDecision } = await import('./src/services/routing-decision-service')
         const lines = []
         const log = pino({}, { write: line => lines.push(line) })
         await recordRoutingDecision('request-1', ${JSON.stringify(observation)}, {}, log)
         console.log(JSON.stringify(lines.map(line => JSON.parse(line))))`
      ],
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(result.exitCode).toBe(0)
    const lines = JSON.parse(result.stdout.toString())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: 'routing_decision_capture', reqId: 'request-1', reason: 'database_error' })
    expect(result.stdout.toString()).not.toContain('DATABASE_URL')
    expect(result.stdout.toString()).not.toContain('caller-model')
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import {
  type DecisionConfig,
  type DecisionInput,
  type DecisionObserver,
  preferredTier
} from '../../../src/llms/tier-router/decision'
import type { RoutingDecisionObservation } from '../../../src/schemas/domain/routing-decision'

const config: DecisionConfig = {
  apiBaseUrl: 'https://decision.example',
  apiKeyEnv: 'JEV_API_KEY',
  enabled: true,
  minConfidence: 0.9,
  model: 'jeff-latest',
  timeoutMs: 1500
}
const input: DecisionInput = {
  candidates: ['opus', 'sonnet'],
  hasTools: true,
  isSubagent: false,
  needsWebSearch: false,
  requestedModel: 'caller-model-識別子',
  requestTokenCount: 4000,
  scenario: 'think',
  thinking: true
}
const env = { JEV_API_KEY: 'private-api-key' }
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function capture() {
  const rows: RoutingDecisionObservation[] = []
  const requests: string[] = []
  const logs: string[] = []
  const log = pino({}, { write: (line: string) => logs.push(line) })
  const observer: DecisionObserver = (row) => {
    rows.push(row)
  }
  return { rows, requests, logs, log, observer }
}

function observeRequest(requests: string[], init?: RequestInit): void {
  if (typeof init?.body !== 'string') throw new Error('Expected a serialized request')
  requests.push(init.body)
}

function response(confidence: number): Response {
  return new Response(
    JSON.stringify({
      answers: { route: { choice: 'opus', confidence, probabilities: { opus: 0.955, sonnet: 0.045 } } },
      credential: 'raw-response-secret'
    })
  )
}

describe('decision completion observer', () => {
  test.each([
    { confidence: 0.94, outcome: 'success', reason: 'accepted', tier: 'opus' },
    { confidence: 0.19, outcome: 'fallback', reason: 'low_confidence', tier: null }
  ])('archives the exact attempted body for $reason without logging it', async (entry) => {
    const { rows, requests, logs, log, observer } = capture()
    globalThis.fetch = async (_url, init) => {
      observeRequest(requests, init)
      return response(entry.confidence)
    }
    expect(await preferredTier(config, input, env, log, observer)).toBe(entry.tier)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestBody: requests[0],
      outcome: entry.outcome,
      reason: entry.reason,
      predictedTier: 'opus',
      confidence: entry.confidence,
      probabilities: { opus: 0.955, sonnet: 0.045 },
      chosenProbability: 0.955,
      httpStatus: 200,
      expectedTier: null,
      evaluationStatus: 'unrated'
    })
    const body = JSON.parse(rows[0].requestBody)
    expect(body.state.requested_model).toBe(input.requestedModel)
    expect(body.questions.route.instructions).toBe(
      'Choose the lowest capability tier that can reliably serve this request.'
    )
    expect(body.questions.route.criteria.opus).toContain('complex multi-step')
    expect(rows[0].requestBody).not.toContain(env.JEV_API_KEY)
    expect(rows[0].requestBody).not.toContain(config.apiBaseUrl)
    expect(JSON.stringify(rows)).not.toContain('raw-response-secret')
    expect(logs.join('')).not.toContain(input.requestedModel)
    expect(logs.join('')).not.toContain('instructions')
    expect(logs.join('')).not.toContain('requestBody')
  })

  test.each([
    { reply: () => new Response('upstream-secret', { status: 503 }), reason: 'http_error', status: 503 },
    { reply: () => new Response('invalid-secret'), reason: 'invalid_json', status: 200 },
    { reply: () => new Response(JSON.stringify({ credential: 'secret' })), reason: 'invalid_response', status: 200 }
  ])('records attempted input on $reason', async ({ reply, reason, status }) => {
    const { rows, requests, log, observer } = capture()
    globalThis.fetch = async (_url, init) => {
      observeRequest(requests, init)
      return reply()
    }
    expect(await preferredTier(config, input, env, log, observer)).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestBody: requests[0],
      outcome: 'fallback',
      reason,
      httpStatus: status,
      predictedTier: null,
      confidence: null,
      probabilities: null,
      chosenProbability: null,
      decisionAccepted: false
    })
  })

  test('network failures still retain the attempted input without error details', async () => {
    const { rows, requests, logs, log, observer } = capture()
    globalThis.fetch = async (_url, init) => {
      observeRequest(requests, init)
      throw new Error('credential-bearing-network-error')
    }
    expect(await preferredTier(config, input, env, log, observer)).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requestBody: requests[0], reason: 'network_error', httpStatus: null })
    expect(JSON.stringify(rows)).not.toContain('credential-bearing-network-error')
    expect(logs.join('')).not.toContain('credential-bearing-network-error')
  })

  test('timeouts retain only the attempted request and normalized failure', async () => {
    const { rows, requests, log, observer } = capture()
    globalThis.fetch = async (_url, init) => {
      observeRequest(requests, init)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('sensitive-timeout')))
      })
    }
    expect(await preferredTier({ ...config, timeoutMs: 5 }, input, env, log, observer)).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ requestBody: requests[0], reason: 'timeout', httpStatus: null })
    expect(JSON.stringify(rows)).not.toContain('sensitive-timeout')
  })

  test('skipped configurations never notify the observer or perform a fetch', async () => {
    const { rows, log, observer } = capture()
    globalThis.fetch = async () => {
      throw new Error('Unexpected fetch')
    }
    for (const settings of [
      { ...config, enabled: false },
      { ...config, apiBaseUrl: null },
      { ...config, model: null }
    ]) {
      expect(await preferredTier(settings, input, env, log, observer)).toBeNull()
    }
    expect(await preferredTier(config, { ...input, candidates: ['opus'] }, env, log, observer)).toBeNull()
    expect(await preferredTier(config, input, {}, log, observer)).toBeNull()
    expect(rows).toHaveLength(0)
  })

  test('slow persistence never delays the routing result', async () => {
    const { log } = capture()
    globalThis.fetch = async () => response(0.94)
    const pending = new Promise<void>(() => {})
    expect(await preferredTier(config, input, env, log, () => pending)).toBe('opus')
  }, 100)

  test('sync and async observer failures do not alter accepted routing or duplicate decisions', async () => {
    const observers: DecisionObserver[] = [
      () => {
        throw new Error('sensitive-writer-error')
      },
      async () => {
        throw new Error('sensitive-writer-error')
      }
    ]
    for (const observer of observers) {
      const { log, logs } = capture()
      globalThis.fetch = async () => response(0.94)
      expect(await preferredTier(config, input, env, log, observer)).toBe('opus')
      await Promise.resolve()
      expect(logs.filter((line) => JSON.parse(line).event === 'routing_decision')).toHaveLength(1)
      expect(logs.filter((line) => JSON.parse(line).event === 'routing_decision_capture')).toHaveLength(1)
      expect(logs.join('')).not.toContain('sensitive-writer-error')
      expect(logs.join('')).not.toContain(input.requestedModel)
    }
  })
})

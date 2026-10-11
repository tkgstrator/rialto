import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { type DecisionConfig, type DecisionInput, preferredTier } from '../../../src/llms/tier-router/decision'

const config: DecisionConfig = {
  apiBaseUrl: 'https://decision.example',
  apiKeyEnv: 'JEV_API_KEY',
  enabled: true,
  minConfidence: 0.9,
  model: 'jev-latest',
  timeoutMs: 1_500
}

const input: DecisionInput = {
  candidates: ['opus', 'sonnet'],
  hasTools: true,
  isSubagent: false,
  needsWebSearch: false,
  requestedModel: 'claude-sonnet-5',
  requestTokenCount: 4_000,
  scenario: 'think',
  thinking: true
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const captureLog = () => {
  const entries: Record<string, unknown>[] = []
  const log = pino({}, { write: (line: string) => entries.push(JSON.parse(line)) })
  return { entries, log }
}

const env = { JEV_API_KEY: 'secret-test-key' }

describe('preferredTier', () => {
  test('logs accepted decisions without request content or secrets', async () => {
    const { entries, log } = captureLog()
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.94 } }, secret: 'response-secret' })
      )
    await expect(preferredTier(config, input, env, log)).resolves.toBe('opus')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      event: 'routing_decision',
      outcome: 'success',
      reason: 'accepted',
      tier: 'opus',
      confidence: 0.94,
      scenario: 'think',
      candidateTiers: ['opus', 'sonnet'],
      minConfidence: 0.9,
      durationMs: expect.any(Number),
      level: 30
    })
    expect(JSON.stringify(entries)).not.toContain('secret')
    expect(JSON.stringify(entries)).not.toContain(config.apiBaseUrl)
    expect(JSON.stringify(entries)).not.toContain(input.requestedModel)
  })

  test('retains only candidate probabilities and separates confidence from chosen probability', async () => {
    const { entries, log } = captureLog()
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          answers: {
            route: {
              choice: 'opus',
              confidence: 0.19,
              probabilities: { opus: 0.595, sonnet: 0.405, credential: 'secret', haiku: 0.9 }
            }
          }
        })
      )
    await expect(preferredTier(config, input, env, log.child({ reqId: 'routing-request' }))).resolves.toBeNull()
    expect(entries[0]).toMatchObject({
      reqId: 'routing-request',
      predictedTier: 'opus',
      chosenProbability: 0.595,
      probabilities: { opus: 0.595, sonnet: 0.405 },
      confidence: 0.19,
      decisionAccepted: false,
      outcome: 'fallback',
      expectedTier: null,
      evaluationStatus: 'unrated'
    })
    expect(JSON.stringify(entries)).not.toContain('credential')
    expect(JSON.stringify(entries)).not.toContain('haiku')
  })

  test('missing or invalid probabilities stay unknown without rejecting a valid choice', async () => {
    for (const probabilities of [undefined, { opus: -1, sonnet: 1.2 }, { opus: 'secret', sonnet: null }]) {
      const { entries, log } = captureLog()
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.94, probabilities } } }))
      await expect(preferredTier(config, input, env, log)).resolves.toBe('opus')
      expect(entries[0]).toMatchObject({ probabilities: null, chosenProbability: null, decisionAccepted: true })
      expect(JSON.stringify(entries)).not.toContain('secret')
    }
  })

  test('logs each skipped configuration without fetching', async () => {
    const cases = [
      { settings: { ...config, enabled: false }, candidates: input, environment: env, reason: 'disabled' },
      { settings: { ...config, apiBaseUrl: null }, candidates: input, environment: env, reason: 'missing_endpoint' },
      { settings: { ...config, model: null }, candidates: input, environment: env, reason: 'missing_model' },
      {
        settings: config,
        candidates: { ...input, candidates: [] },
        environment: env,
        reason: 'insufficient_candidates'
      },
      { settings: config, candidates: input, environment: {}, reason: 'missing_api_key' },
      { settings: config, candidates: input, environment: { JEV_API_KEY: '' }, reason: 'missing_api_key' }
    ]
    globalThis.fetch = async () => {
      throw new Error('must not fetch')
    }
    for (const entry of cases) {
      const { entries, log } = captureLog()
      await expect(preferredTier(entry.settings, entry.candidates, entry.environment, log)).resolves.toBeNull()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: 'skipped', reason: entry.reason, level: 30 })
    }
  })

  test('logs HTTP, JSON, malformed answers, low confidence and network fallbacks', async () => {
    const cases = [
      { response: () => new Response('response-secret', { status: 503 }), reason: 'http_error' },
      { response: () => new Response('response-secret'), reason: 'invalid_json' },
      { response: () => new Response('{}'), reason: 'invalid_response' },
      {
        response: () => new Response(JSON.stringify({ answers: { route: { choice: 'haiku', confidence: 0.99 } } })),
        reason: 'invalid_response'
      },
      {
        response: () => new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 1.1 } } })),
        reason: 'invalid_response'
      },
      {
        response: () => new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.89 } } })),
        reason: 'low_confidence'
      },
      {
        response: () => {
          throw new Error('network-secret')
        },
        reason: 'network_error'
      }
    ]
    for (const entry of cases) {
      const { entries, log } = captureLog()
      globalThis.fetch = async () => entry.response()
      await expect(preferredTier(config, input, env, log)).resolves.toBeNull()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: 'fallback', reason: entry.reason, level: 40 })
      if (entry.reason === 'http_error') expect(entries[0]?.httpStatus).toBe(503)
      if (entry.reason === 'low_confidence') expect(entries[0]).toMatchObject({ tier: 'opus', confidence: 0.89 })
      expect(JSON.stringify(entries)).not.toContain('secret')
    }
  })

  test('logs aborted requests as timeout', async () => {
    const { entries, log } = captureLog()
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout-secret')), { once: true })
      })
    await expect(preferredTier({ ...config, timeoutMs: 1 }, input, env, log)).resolves.toBeNull()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ outcome: 'fallback', reason: 'timeout', level: 40 })
    expect(JSON.stringify(entries)).not.toContain('secret')
  })

  test('sends only task text and accepts a confident eligible choice', async () => {
    let sent: unknown
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.94 } } }))
    }

    await expect(
      preferredTier(config, { ...input, taskText: 'Fix a typo' }, { JEV_API_KEY: 'test-key' })
    ).resolves.toBe('opus')
    expect(sent).toMatchObject({
      model: 'jev-latest',
      questions: { route: { criteria: { opus: expect.any(String), sonnet: expect.any(String) } } }
    })
    expect((sent as { state: unknown }).state).toEqual({ task: 'Fix a typo' })
    expect(JSON.stringify(sent)).not.toContain('test-key')
  })

  test('changing routing metadata does not change the classifier request', async () => {
    const bodies: string[] = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.94 } } }))
    }
    await preferredTier(config, { ...input, taskText: 'Fix a typo' }, env)
    await preferredTier(
      config,
      {
        ...input,
        taskText: 'Fix a typo',
        requestedModel: 'haiku',
        thinking: false,
        scenario: 'default',
        hasTools: false,
        needsWebSearch: true,
        isSubagent: true,
        requestTokenCount: 100000
      },
      env
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })

  test('keeps the profile order when confidence is low, choice is unavailable, or the API fails', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.89 } } }))
    await expect(preferredTier(config, input, { JEV_API_KEY: 'test-key' })).resolves.toBeNull()

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'haiku', confidence: 0.99 } } }))
    await expect(preferredTier(config, input, { JEV_API_KEY: 'test-key' })).resolves.toBeNull()

    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await expect(preferredTier(config, input, { JEV_API_KEY: 'test-key' })).resolves.toBeNull()
  })

  test('does not call an incomplete or disabled decision service', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response('{}')
    }
    await expect(preferredTier({ ...config, enabled: false }, input)).resolves.toBeNull()
    await expect(preferredTier({ ...config, model: null }, input)).resolves.toBeNull()
    expect(calls).toBe(0)
  })
})

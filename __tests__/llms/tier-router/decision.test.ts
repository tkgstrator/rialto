import { afterEach, describe, expect, test } from 'bun:test'
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

describe('preferredTier', () => {
  test('sends only routing metadata and accepts a confident eligible choice', async () => {
    let sent: unknown
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.94 } } }))
    }

    await expect(preferredTier(config, input, { JEV_API_KEY: 'test-key' })).resolves.toBe('opus')
    expect(sent).toMatchObject({
      model: 'jev-latest',
      state: {
        has_tools: true,
        scenario: 'think',
        thinking_enabled: true
      },
      questions: { route: { criteria: { opus: expect.any(String), sonnet: expect.any(String) } } }
    })
    expect(JSON.stringify(sent)).not.toContain('test-key')
  })

  test('keeps the profile order when confidence is low, choice is unavailable, or the API fails', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'opus', confidence: 0.89 } } }))
    await expect(preferredTier(config, input)).resolves.toBeNull()

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ answers: { route: { choice: 'haiku', confidence: 0.99 } } }))
    await expect(preferredTier(config, input)).resolves.toBeNull()

    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await expect(preferredTier(config, input)).resolves.toBeNull()
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

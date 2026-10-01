import { afterEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { sendToProvider } from '../../src/llms/pipeline/provider-send'
import { processRequestTransformers } from '../../src/llms/pipeline/request-chain'
import type { ResolvedProvider } from '../../src/llms/registry/provider'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAITransformer } from '../../src/llms/transformers/openai'
import type { TransformerContext } from '../../src/schemas/domain/pipeline'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const gemini = new GeminiTransformer()
const provider: ResolvedProvider = {
  name: 'google',
  api_base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
  api_key: 'private-provider-key',
  models: ['gemini-transformed-model'],
  transformer: { use: [gemini] }
}
const context = (): TransformerContext => ({
  req: {
    headers: {},
    body: {},
    url: '/v1/messages',
    model: 'stale-inbound-model',
    reqId: 'gemini-request',
    selectedTier: 'opus',
    selectedRoute: 'google · opus',
    isSubagent: false
  }
})

const captureLog = () => {
  const entries: Record<string, unknown>[] = []
  const log = pino({}, { write: (line: string) => entries.push(JSON.parse(line)) })
  return { entries, log }
}

describe('Gemini routing upstream observations', () => {
  for (const bypass of [true, false]) {
    test(`${bypass ? 'bypass' : 'converted'} path records the actual path model without a URL or credential`, async () => {
      const ctx = context()
      const transformer = bypass ? gemini : new OpenAITransformer()
      const input = {
        body: bypass
          ? { model: 'gemini-transformed-model', stream: true, contents: [] }
          : { model: 'gemini-transformed-model', stream: true, messages: [] },
        headers: {},
        provider,
        transformer,
        context: ctx
      }
      const { requestBody, config } = await processRequestTransformers(input, bypass)
      if (!bypass) expect(config.outboundModel).toBe('gemini-transformed-model')
      const { entries, log } = captureLog()
      globalThis.fetch = async (_url, options) => {
        const sent = JSON.parse(String(options?.body))
        expect(sent.model).toBeUndefined()
        expect(sent.outboundModel).toBeUndefined()
        return new Response('{}', { status: 200 })
      }
      await sendToProvider(requestBody, config, provider, transformer, bypass, ctx, { log })
      const observations = entries.filter((entry) => entry.event === 'routing_upstream')
      expect(observations.map((entry) => entry.outcome)).toEqual(['send', 'success'])
      for (const observation of observations) {
        expect(observation).toMatchObject({
          reqId: 'gemini-request',
          provider: 'google',
          model: 'gemini-transformed-model',
          selectedTier: 'opus',
          selectedRoute: 'google · opus'
        })
      }
      expect(observations[1]?.status).toBe(200)
      expect(observations[0]?.attemptId).toBe(observations[1]?.attemptId)
      expect(JSON.stringify(observations)).not.toContain('https://')
      expect(JSON.stringify(observations)).not.toContain('private-provider-key')
      expect(JSON.stringify(observations)).not.toContain('stale-inbound-model')
    })
  }

  test('a missing Gemini model is explicitly unknown rather than inferred from context', async () => {
    const { entries, log } = captureLog()
    globalThis.fetch = async () => new Response('{}', { status: 200 })
    await sendToProvider({ contents: [] }, {}, provider, gemini, true, context(), { log })
    const observations = entries.filter((entry) => entry.event === 'routing_upstream')
    expect(observations).toHaveLength(2)
    for (const observation of observations) expect(observation.model).toBeNull()
  })
})

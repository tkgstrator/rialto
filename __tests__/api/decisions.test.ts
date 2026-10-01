import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'
import { adminAuth } from '../../src/api/api-key-auth'
import { decisionsRoute } from '../../src/api/decisions/route'
import { DecisionEvaluateResponseSchema } from '../../src/schemas/api/decisions'
import { __resetJeffQueueForTest } from '../../src/services/jeff-client'

const originalFetch = globalThis.fetch
const originalUrl = process.env.JEFF_URL
const originalKey = process.env.JEFF_API_KEY
const originalShadow = process.env.JEFF_SHADOW_ENABLED
const originalTrustLocal = process.env.RIALTO_TRUST_LOCAL
const app = new OpenAPIHono()
app.use('/api/*', adminAuth)
app.route('/', decisionsRoute)

const request = (path: string, body?: unknown, host = 'localhost:16175') =>
  app.fetch(
    new Request(
      `http://${host}${path}`,
      body === undefined
        ? { headers: { host } }
        : {
            method: 'POST',
            headers: { host, 'content-type': 'application/json' },
            body: JSON.stringify(body)
          }
    )
  )

const payload = {
  state: 'The customer was charged twice.',
  model: 'jeff-latest',
  questions: {
    queue: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, support: 'Other' } },
    billing: { type: 'noul', instructions: 'About billing?' },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] }
  }
}
const answer = {
  model: 'jeff-qwen3.5-0.8b',
  answers: {
    queue: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, support: 0.2 }, confidence: 0.6 },
    billing: { type: 'noul', noul: 0.9 },
    urgency: {
      type: 'score',
      score: 0.7,
      probabilities: { '0': 0.3, '1': 0.7 },
      confidence: 0.4,
      legend: { '0': 'low', '1': 'high' }
    }
  },
  usage: { input_tokens: 25, output_tokens: 0 }
}
const calls: { url: string; init: RequestInit | undefined }[] = []

beforeEach(() => {
  __resetJeffQueueForTest()
  calls.length = 0
  process.env.JEFF_URL = 'http://127.0.0.1:8000/'
  process.env.JEFF_API_KEY = 'server-secret'
  process.env.JEFF_SHADOW_ENABLED = 'false'
  delete process.env.RIALTO_TRUST_LOCAL
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init })
    return Response.json(String(input).endsWith('/health') ? { status: 'ready', model: 'jeff-qwen3.5-0.8b' } : answer)
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
})

afterEach(() => {
  __resetJeffQueueForTest()
  globalThis.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.JEFF_URL
  else process.env.JEFF_URL = originalUrl
  if (originalKey === undefined) delete process.env.JEFF_API_KEY
  else process.env.JEFF_API_KEY = originalKey
  if (originalShadow === undefined) delete process.env.JEFF_SHADOW_ENABLED
  else process.env.JEFF_SHADOW_ENABLED = originalShadow
  if (originalTrustLocal === undefined) delete process.env.RIALTO_TRUST_LOCAL
  else process.env.RIALTO_TRUST_LOCAL = originalTrustLocal
})

test('admin-only status probes fixed health path with a timeout', async () => {
  const res = await request('/api/decisions/status')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    configured: true,
    ready: true,
    shadowEnabled: false,
    model: 'jeff-qwen3.5-0.8b',
    error: null
  })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('http://127.0.0.1:8000/health')
  expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false)
  expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
  expect(calls[0].init?.redirect).toBe('error')

  const denied = await request('/api/decisions/status', undefined, 'public.example.com')
  expect(denied.status).toBe(401)
  expect(calls).toHaveLength(1)
})

test('health keeps a three-second budget while playground evaluations allow five seconds', async () => {
  const timeout = spyOn(AbortSignal, 'timeout')
  try {
    expect((await request('/api/decisions/status')).status).toBe(200)
    expect((await request('/api/decisions/evaluate', payload)).status).toBe(200)
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([3_000, 5_000])
  } finally {
    timeout.mockRestore()
  }
})

test('evaluate validates all question types and relays only to configured Jeff', async () => {
  const res = await request('/api/decisions/evaluate', payload)
  expect(res.status).toBe(200)
  const result = DecisionEvaluateResponseSchema.safeParse(await res.json())
  expect(result.success).toBe(true)
  expect(calls[0].url).toBe('http://127.0.0.1:8000/v1/systemone')
  expect(calls[0].init?.method).toBe('POST')
  expect(JSON.parse(String(calls[0].init?.body))).toEqual(payload)

  const denied = await request('/api/decisions/evaluate', payload, 'public.example.com')
  expect(denied.status).toBe(401)
  expect(calls).toHaveLength(1)
  expect((await request('/v1/systemone', payload)).status).toBe(404)
})

test('rejects an injected URL, malformed criteria and unsupported question types before fetch', async () => {
  for (const bad of [
    { ...payload, url: 'https://attacker.example/v1/systemone' },
    { ...payload, questions: { q: { type: 'score', criteria: [] } } },
    { ...payload, questions: { q: { type: 'choice', criteria: {} } } },
    { ...payload, questions: { q: { type: 'unknown', criteria: {} } } },
    { ...payload, state: { nested: 'unsupported in the admin playground' } },
    { ...payload, state: 'x'.repeat(8_001) }
  ]) {
    const res = await request('/api/decisions/evaluate', bad)
    expect(res.status).toBe(400)
  }
  expect(calls).toHaveLength(0)
})

test('unavailable Jeff and invalid responses fail closed', async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ unexpected: true }), {
    preconnect: originalFetch.preconnect
  })
  expect(await (await request('/api/decisions/status')).json()).toEqual({
    configured: true,
    ready: false,
    shadowEnabled: false,
    model: null,
    error: 'Jeff returned an invalid health response.'
  })
  const res = await request('/api/decisions/evaluate', payload)
  expect(res.status).toBe(502)
  expect(await res.json()).toEqual({ error: 'Jeff returned an invalid response.' })

  process.env.JEFF_URL = 'file:///etc/passwd'
  expect(await (await request('/api/decisions/status')).json()).toEqual({
    configured: true,
    ready: false,
    shadowEnabled: false,
    model: null,
    error: 'Jeff URL is invalid.'
  })
  expect((await request('/api/decisions/evaluate', payload)).status).toBe(502)
})

test('upstream network failures and HTTP errors are contained', async () => {
  const failing = async (): Promise<Response> => {
    throw new Error('private upstream URL or credentials must not leak')
  }
  globalThis.fetch = Object.assign(failing, { preconnect: originalFetch.preconnect })
  expect(await (await request('/api/decisions/status')).json()).toEqual({
    configured: true,
    ready: false,
    shadowEnabled: false,
    model: null,
    error: 'Jeff is unavailable or timed out.'
  })
  const unreachable = await request('/api/decisions/evaluate', payload)
  expect(unreachable.status).toBe(502)
  expect(JSON.stringify(await unreachable.json())).not.toContain('private upstream')

  globalThis.fetch = Object.assign(async () => Response.json({ detail: 'private' }, { status: 422 }), {
    preconnect: originalFetch.preconnect
  })
  const rejected = await request('/api/decisions/evaluate', payload)
  expect(rejected.status).toBe(502)
  expect(await rejected.json()).toEqual({ error: 'Jeff returned HTTP 422.' })
})

test('unconfigured Jeff is disabled until the operator sets JEFF_URL', async () => {
  delete process.env.JEFF_URL
  expect(await (await request('/api/decisions/status')).json()).toEqual({
    configured: false,
    ready: false,
    shadowEnabled: false,
    model: null,
    error: null
  })
  expect((await request('/api/decisions/evaluate', payload)).status).toBe(502)
  expect(calls).toHaveLength(0)
})

test('optional API key is omitted when unset', async () => {
  delete process.env.JEFF_API_KEY
  await request('/api/decisions/evaluate', payload)
  expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false)
})

test('overlapping evaluate requests take turns instead of reaching Jeff together', async () => {
  const state = { inFlight: 0, maxInFlight: 0 }
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      state.inFlight--
      return Response.json(answer)
    },
    { preconnect: originalFetch.preconnect }
  )
  const responses = await Promise.all([1, 2, 3].map(() => request('/api/decisions/evaluate', payload)))
  expect(responses.map((res) => res.status)).toEqual([200, 200, 200])
  expect(state.maxInFlight).toBe(1)
})

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { audioRoute } from '../../src/api/v1/audio'
import { v1Route } from '../../src/api/v1/route'
import { getPrismaClient } from '../../src/db/client'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { DEFAULT_TOKEN_POLICY } from '../../src/shared/access-token-policy'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const app = new Hono()
app.use('/v1/*', inboundProxyAuth)
app.route('/', audioRoute)
app.route('/', v1Route)

const originalFetch = globalThis.fetch
const send = (path: string, token: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

describe.skipIf(!HAS_DB)('OpenAI specialized endpoints', () => {
  beforeEach(async () => {
    await resetDbTables()
    invalidateTokenCache()
    invalidateSurfaceCache()
    await getPrismaClient().provider.create({
      data: {
        name: 'openai',
        apiBaseUrl: 'https://api.openai.com/v1/responses',
        apiKey: 'upstream-key',
        models: {
          create: [
            { name: 'gpt-6-luna', enabled: true },
            { name: 'gpt-4o-mini-tts', enabled: true }
          ]
        }
      }
    })
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    invalidateSurfaceCache()
  })
  afterAll(teardownPrisma)

  test('sends Decisions as JSON through a Responses-scoped token', async () => {
    const { plaintext } = await issueAccessToken({ name: 'decisions', surfaces: ['openai-responses'] })
    const response = { id: 'decision-1', output: [], usage: { input_tokens: 2, output_tokens: 1 } }
    const calls: unknown[] = []
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push([String(url), new Headers(init?.headers).get('authorization'), JSON.parse(String(init?.body))])
        return Response.json(response)
      },
      { preconnect: originalFetch.preconnect }
    )
    const body = { model: 'openai,gpt-6-luna', input: 'Example', questions: [] }
    const res = await send('/v1/decisions', plaintext, body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(response)
    expect(calls).toEqual([
      ['https://api.openai.com/v1/decisions', 'Bearer upstream-key', { ...body, model: 'gpt-6-luna' }]
    ])
  })

  test('streams the OpenAI speech body and enforces the token’s provider policy', async () => {
    const body = { model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'alloy' }
    const token = await issueAccessToken({ name: 'speech', surfaces: ['openai-chat'] })
    const blocked = await issueAccessToken({
      name: 'blocked speech',
      policy: { ...DEFAULT_TOKEN_POLICY, providerMode: 'subscription_only' }
    })
    const calls: unknown[] = []
    globalThis.fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push([String(url), new Headers(init?.headers).get('authorization'), JSON.parse(String(init?.body))])
        return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } })
      },
      { preconnect: originalFetch.preconnect }
    )
    expect((await send('/v1/audio/speech', blocked.plaintext, body)).status).toBe(403)
    const res = await send('/v1/audio/speech', token.plaintext, body)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([73, 68, 51]))
    expect(calls).toEqual([['https://api.openai.com/v1/audio/speech', 'Bearer upstream-key', body]])
  })
})

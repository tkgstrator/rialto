import { afterAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { accessTokensRoute } from '../../src/api/access-tokens/route'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { providerByNameRoute } from '../../src/api/providers/[name]/route'
import { loadPreviews } from '../../src/api/request-logs/preview'
import { v1Route } from '../../src/api/v1/route'
import { getPrismaClient } from '../../src/db/client'
import { firstUserInputOf } from '../../src/lib/sessions/first-user-input'
import { issueAccessToken, resolveAccessToken } from '../../src/services/access-token-service'
import { applyUiConfig } from '../../src/services/config'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

afterAll(teardownPrisma)

test('extracts only the first user text across supported request shapes', () => {
  expect(firstUserInputOf({ input: 'Responses prompt' })).toBe('Responses prompt')
  expect(
    firstUserInputOf({
      input: [
        { role: 'developer', content: 'Developer text' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'First request' },
            { type: 'input_image', image_url: 'data:...' }
          ]
        },
        { role: 'user', content: 'Later request' }
      ]
    })
  ).toBe('First request')
  expect(
    firstUserInputOf({
      contents: [
        { role: 'user', parts: [{ text: 'Gemini prompt' }, { inlineData: { data: 'image payload' } }] },
        { role: 'model', parts: [{ text: 'Assistant text' }] }
      ]
    })
  ).toBe('Gemini prompt')
  expect(
    firstUserInputOf({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', content: 'Tool output' }] },
        { role: 'user', content: 'x'.repeat(5000) }
      ]
    })?.length
  ).toBe(4096)
})

test.skipIf(!HAS_DB)('completion records metadata and only the first user input', async () => {
  const prisma = getPrismaClient()
  await resetDbTables()
  await applyUiConfig({
    Providers: [
      {
        name: 'anthropic',
        api_base_url: 'https://api.anthropic.com/v1/messages',
        api_key: 'test-key',
        auth_mode: 'api_key',
        models: ['claude-test']
      }
    ]
  })
  const issued = await issueAccessToken({ name: 'metadata-only' })
  const app = new Hono()
  app.use('/v1/*', inboundProxyAuth)
  app.route('/', v1Route)
  const originalFetch = globalThis.fetch
  const assistant = [{ type: 'text', text: 'Private assistant response' }]
  const upstream = async () =>
    Response.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: assistant,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 }
    })
  globalThis.fetch = Object.assign(upstream, { preconnect: originalFetch.preconnect })
  try {
    const complete = (prompt: string) =>
      app.request('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': issued.plaintext,
          'x-claude-code-session-id': 'metadata-only-session'
        },
        body: JSON.stringify({
          model: 'anthropic,claude-test',
          max_tokens: 64,
          messages: [{ role: 'user', content: prompt }]
        })
      })
    const response = await complete('First user prompt')
    expect(response.status).toBe(200)
    expect((await response.json()).content).toEqual(assistant)
    expect((await complete('Later user prompt')).status).toBe(200)
    for (const _ of Array.from({ length: 40 })) {
      if ((await prisma.requestLog.count()) >= 2) break
      await Bun.sleep(10)
    }
    const log = await prisma.requestLog.findFirstOrThrow()
    expect(log).toMatchObject({ model: 'claude-test', inputTokens: 12, outputTokens: 3 })
    expect(await prisma.session.findUnique({ where: { id: log.sessionId } })).toMatchObject({
      firstUserInput: 'First user prompt'
    })
    expect((await loadPreviews([log.sessionId])).get(log.sessionId)).toBe('First user prompt')
    expect(await prisma.message.count({ where: { sessionId: log.sessionId } })).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
    await prisma.accessToken.delete({ where: { id: issued.token.id } })
  }
})

test.skipIf(!HAS_DB)('renaming a token preserves its identity and the same credential still resolves', async () => {
  const token = await issueAccessToken({ name: 'Before rename' })
  const res = await accessTokensRoute.request(`/api/access-tokens/${token.token.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: ' Renamed client ' })
  })
  try {
    expect(res.status).toBe(200)
    expect(await resolveAccessToken(token.plaintext)).toMatchObject({ id: token.token.id, name: 'Renamed client' })
  } finally {
    await getPrismaClient().accessToken.delete({ where: { id: token.token.id } })
  }
})

test.skipIf(!HAS_DB)('editing provider connection preserves its routing ID and model associations', async () => {
  const prisma = getPrismaClient()
  await resetDbTables()
  const provider = await prisma.provider.create({
    data: {
      name: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      models: { create: { name: 'model-a', enabled: true, testStatus: 'ok' } }
    }
  })
  const endpoint = '/api/providers/openai/connection'
  const update = (value: string) =>
    providerByNameRoute.request(endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'OpenAI gateway', api_base_url: value })
    })
  expect((await update('https://user:pass@example.com/v1/chat/completions')).status).toBe(400)
  expect((await update('https://example.com/v1/chat/completions')).status).toBe(200)
  const saved = await prisma.provider.findUnique({ where: { id: provider.id }, include: { models: true } })
  expect(saved).toMatchObject({
    name: 'openai',
    displayName: 'OpenAI gateway',
    apiBaseUrl: 'https://example.com/v1/chat/completions',
    apiKey: 'test-key',
    models: [{ name: 'model-a', enabled: true, testStatus: 'unknown' }]
  })
})

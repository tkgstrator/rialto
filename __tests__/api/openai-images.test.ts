import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { v1Route } from '../../src/api/v1/route'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { clearAccountExhaustion, isAccountExhausted } from '../../src/services/failover-state'
import { invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { setModelProviderPriorities } from '../../src/services/model-provider-preference'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations'
const MODEL = 'gpt-image-2.5-flare'
const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_KEY = process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
const ORIGINAL_CAPTURE = process.env.CAPTURE_REQUESTS
const payload = {
  created: 42,
  data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUg==' }],
  usage: { input_tokens: 18, output_tokens: 343 }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })

const app = new Hono()
app.use('/v1/*', inboundProxyAuth)
app.route('/', v1Route)

const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
const replies: Response[] = []
const send = (body: unknown, token: string, headers: Record<string, string> = {}): Promise<Response> =>
  app.fetch(
    new Request('http://local/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  )

const createProvider = async (name = 'codex', enabled = true, base = 'https://chatgpt.com/backend-api/codex') => {
  const db = getPrismaClient()
  const provider = await db.provider.create({ data: { name, apiBaseUrl: base, authMode: 'subscription', enabled } })
  await db.model.create({ data: { providerId: provider.id, name: MODEL, enabled: true } })
  return provider
}

const createAccount = async (providerId: string, label: string) => {
  const account = await getPrismaClient().subAccount.create({
    data: {
      providerId,
      label,
      sourcePath: `oauth:test:${label}`,
      accountId: `account-${label}`,
      accessTokenEnc: encryptString(`oauth-${label}`, encryptionKey()),
      expiresAt: dayjs('2099-01-01T00:00:00Z').toDate()
    }
  })
  return account.id
}

const stubUpstream = () => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== ENDPOINT) throw new Error(`unexpected upstream: ${url}`)
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    const reply = replies.shift()
    return reply === undefined ? json(payload) : reply
  }
  globalThis.fetch = Object.assign(fake, { preconnect: ORIGINAL_FETCH.preconnect })
}

describe.skipIf(!HAS_DB)('POST /v1/images/generations', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = 'ab'.repeat(32)
    delete process.env.CAPTURE_REQUESTS
    await resetDbTables()
    invalidateTokenCache()
    invalidateSurfaceCache()
    calls.length = 0
    replies.length = 0
    stubUpstream()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    if (ORIGINAL_KEY === undefined) delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    else process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = ORIGINAL_KEY
    if (ORIGINAL_CAPTURE === undefined) delete process.env.CAPTURE_REQUESTS
    else process.env.CAPTURE_REQUESTS = ORIGINAL_CAPTURE
    invalidateSurfaceCache()
  })

  afterAll(teardownPrisma)

  test('requires a Bearer token scoped to the image surface', async () => {
    const body = { model: `codex,${MODEL}`, prompt: 'A paper lantern' }
    const chatOnly = (await issueAccessToken({ name: 'chat-only', surfaces: ['openai-chat'] })).plaintext
    const imageOnly = (await issueAccessToken({ name: 'image-only', surfaces: ['openai-images'] })).plaintext
    const unauthorized = await send(body, 'not-a-token')
    expect(unauthorized.status).toBe(401)
    expect((await unauthorized.json()).error.code).toBe('invalid_api_key')
    expect((await send(body, chatOnly)).status).toBe(401)
    const apiKey = await send(body, '', { authorization: '', 'x-api-key': imageOnly })
    expect(apiKey.status).toBe(401)
    expect((await send(body, imageOnly)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('forwards a supported image request with server-owned OAuth headers and captures usage', async () => {
    const provider = await createProvider()
    const accountId = await createAccount(provider.id, 'a')
    const issued = await issueAccessToken({ name: 'image', surfaces: ['openai-images'] })
    const result = await send(
      { model: `codex,${MODEL}`, prompt: 'A paper lantern', size: '1024x1024', response_format: 'b64_json' },
      issued.plaintext,
      { 'chatgpt-account-id': 'injected', originator: 'untrusted' }
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual(payload)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ENDPOINT)
    expect(calls[0].headers.get('authorization')).toBe('Bearer oauth-a')
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('account-a')
    expect(calls[0].headers.get('originator')).toBe('codex_exec')
    expect(calls[0].body).toEqual({ model: MODEL, prompt: 'A paper lantern', size: '1024x1024' })
    const logs = await getPrismaClient().requestLog.findMany()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      provider: 'codex',
      model: MODEL,
      requestedModel: `codex,${MODEL}`,
      surface: 'openai-images',
      scenario: 'passthrough',
      subAccountId: accountId,
      accessTokenId: issued.token.id,
      inputTokens: 18,
      outputTokens: 343
    })
    expect(await getPrismaClient().message.count()).toBe(0)
  })

  test('rejects disabled targets, ambiguous names, and unsupported models without a network call', async () => {
    const provider = await createProvider()
    await createAccount(provider.id, 'a')
    const token = (await issueAccessToken({ name: 'image' })).plaintext
    const second = await createProvider('codex-other')
    await createAccount(second.id, 'second')
    expect((await send({ model: MODEL, prompt: 'x' }, token)).status).toBe(400)
    expect((await send({ model: 'codex,gpt-5.5', prompt: 'x' }, token)).status).toBe(400)
    await getPrismaClient().model.updateMany({ where: { providerId: provider.id }, data: { enabled: false } })
    expect((await send({ model: `codex,${MODEL}`, prompt: 'x' }, token)).status).toBe(400)
    await getPrismaClient().model.updateMany({ where: { providerId: provider.id }, data: { enabled: true } })
    await getPrismaClient().provider.update({ where: { id: provider.id }, data: { enabled: false } })
    expect((await send({ model: `codex,${MODEL}`, prompt: 'x' }, token)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('uses the configured provider for a duplicated bare image model', async () => {
    const first = await createProvider('codex')
    await createAccount(first.id, 'first')
    const second = await createProvider('codex-other')
    await createAccount(second.id, 'second')
    const token = (await issueAccessToken({ name: 'image', surfaces: ['openai-images'] })).plaintext
    expect((await send({ model: MODEL, prompt: 'x' }, token)).status).toBe(400)
    await setModelProviderPriorities(MODEL, ['codex-other', 'codex'])
    const result = await send({ model: MODEL, prompt: 'x' }, token)
    expect(result.status).toBe(200)
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('account-second')
    expect(calls[0].body.model).toBe(MODEL)
  })

  test('skips a preferred image provider without a usable account', async () => {
    const first = await createProvider('codex')
    await createAccount(first.id, 'first')
    await createProvider('codex-other')
    await setModelProviderPriorities(MODEL, ['codex-other', 'codex'])
    const token = (await issueAccessToken({ name: 'image', surfaces: ['openai-images'] })).plaintext
    expect((await send({ model: MODEL, prompt: 'x' }, token)).status).toBe(200)
    expect(calls[0].headers.get('chatgpt-account-id')).toBe('account-first')
  })

  test('refuses image upstream URLs with credentials or other URL modifiers', async () => {
    for (const base of [
      'https://user:secret@chatgpt.com/backend-api/codex',
      'https://chatgpt.com/backend-api/codex?redirect=1',
      'https://chatgpt.com/backend-api/codex#fragment',
      'https://chatgpt.com:444/backend-api/codex',
      'http://chatgpt.com/backend-api/codex'
    ]) {
      await resetDbTables()
      invalidateTokenCache()
      const provider = await createProvider('codex', true, base)
      await createAccount(provider.id, 'a')
      const issued = await issueAccessToken({ name: 'image' })
      expect((await send({ model: MODEL, prompt: 'x' }, issued.plaintext)).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  test('rejects unsupported fields and oversized bodies before dispatch', async () => {
    const provider = await createProvider()
    await createAccount(provider.id, 'a')
    const token = (await issueAccessToken({ name: 'image' })).plaintext
    for (const body of [
      { model: MODEL, prompt: 'x', n: 2 },
      { model: MODEL, prompt: 'x', stream: true },
      { model: MODEL, prompt: 'x', response_format: 'url' },
      { model: MODEL, prompt: 'x'.repeat(130_000) }
    ])
      expect((await send(body, token)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test('rotates an account after a 429 and returns the next image', async () => {
    const provider = await createProvider()
    const first = await createAccount(provider.id, 'a')
    const second = await createAccount(provider.id, 'b')
    replies.push(json({ detail: 'rate limited' }, 429), json(payload))
    const token = (await issueAccessToken({ name: 'image' })).plaintext
    const result = await send({ model: MODEL, prompt: 'x' }, token)
    expect(result.status).toBe(200)
    expect((await result.json()).data).toEqual(payload.data)
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((call) => call.headers.get('chatgpt-account-id'))).size).toBe(2)
    expect(isAccountExhausted(first) || isAccountExhausted(second)).toBe(true)
    clearAccountExhaustion(first)
    clearAccountExhaustion(second)
  })

  test('wraps upstream errors and refuses malformed success without recording usage', async () => {
    const provider = await createProvider()
    await createAccount(provider.id, 'a')
    const token = (await issueAccessToken({ name: 'image' })).plaintext
    replies.push(json({ detail: 'unsupported size' }, 400), json({ data: [] }))
    const error = await send({ model: MODEL, prompt: 'x' }, token)
    expect(error.status).toBe(400)
    expect((await error.json()).error.message).toContain('unsupported size')
    const malformed = await send({ model: MODEL, prompt: 'x' }, token)
    expect(malformed.status).toBe(502)
    expect(await getPrismaClient().requestLog.count()).toBe(0)
  })
})

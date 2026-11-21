import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { v1ModelsRoute } from '../../src/api/v1/models-list'
import { v1Route } from '../../src/api/v1/route'
import { providerFromCatalog } from '../../src/components/rialto/providers/connect-actions'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { getCatalog } from '../../src/services/catalog-service'
import { applyUiConfig } from '../../src/services/config'
import { clearAccountExhaustion, isAccountExhausted } from '../../src/services/failover-state'
import { invalidateSurfaceCache, updateSurface } from '../../src/services/inbound-surface-service'
import { setModelProviderPriorities } from '../../src/services/model-provider-preference'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { DEFAULT_TOKEN_POLICY } from '../../src/shared/access-token-policy'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations'
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/images/generations'
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
app.route('/', v1ModelsRoute)

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
    if (url !== ENDPOINT && url !== OPENAI_ENDPOINT) throw new Error(`unexpected upstream: ${url}`)
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

  test('lists enabled OpenAI API image models and generates with the configured key', async () => {
    const db = getPrismaClient()
    const models = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']
    const catalog = await getCatalog(async () => new Response(null, { status: 503 }))
    const openai = catalog.find((entry) => entry.name === 'openai')
    if (openai === undefined) throw new Error('OpenAI catalog entry missing')
    await applyUiConfig({
      Providers: [{ ...providerFromCatalog(openai), api_key: 'upstream-key', enabled: true }]
    })
    const provider = await db.provider.findUniqueOrThrow({ where: { name: 'openai' }, include: { models: true } })
    expect(
      provider.models
        .filter((row) => models.includes(row.name))
        .map((row) => [row.name, row.enabled])
        .sort()
    ).toEqual(models.map((name) => [name, false]))
    await db.model.updateMany({ where: { providerId: provider.id, name: { in: models } }, data: { enabled: true } })
    const token = (await issueAccessToken({ name: 'image', surfaces: ['openai-images'] })).plaintext
    const list = () => app.request('/v1/models', { headers: { authorization: `Bearer ${token}` } })
    expect((await (await list()).json()).data.map((model: { id: string }) => model.id)).toEqual(models)

    for (const model of models) {
      const result = await send({ model, prompt: 'A paper lantern' }, token)
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual(payload)
    }
    expect(calls.map((call) => call.body.model)).toEqual(models)
    for (const call of calls) {
      expect(call.url).toBe(OPENAI_ENDPOINT)
      expect(call.headers.get('authorization')).toBe('Bearer upstream-key')
      expect(call.headers.has('chatgpt-account-id')).toBe(false)
    }

    const restricted = (
      await issueAccessToken({
        name: 'flare-only',
        surfaces: ['openai-images'],
        policy: {
          ...DEFAULT_TOKEN_POLICY,
          restrictModels: true,
          allowedModels: [models[0]],
          providerMode: 'api_key_only'
        }
      })
    ).plaintext
    const restrictedList = await app.request('/v1/models', { headers: { authorization: `Bearer ${restricted}` } })
    expect((await restrictedList.json()).data.map((model: { id: string }) => model.id)).toEqual([models[0]])
    expect((await send({ model: `openai,${models[1]}`, prompt: 'x' }, restricted)).status).toBe(403)

    await db.provider.update({ where: { id: provider.id }, data: { apiKey: null } })
    expect((await (await list()).json()).data).toEqual([])
    expect((await send({ model: models[0], prompt: 'x' }, token)).status).toBe(400)
    expect(calls).toHaveLength(models.length)
  })

  test('edits an uploaded image with the image scope and forwards the resolved model', async () => {
    const db = getPrismaClient()
    const provider = await db.provider.create({
      data: { name: 'openai', apiBaseUrl: 'https://api.openai.com/v1/responses', apiKey: 'upstream-key', enabled: true }
    })
    const model = 'gpt-image-2.6-flare'
    await db.model.create({ data: { providerId: provider.id, name: model, enabled: true } })
    const imageToken = (await issueAccessToken({ name: 'edit', surfaces: ['openai-images'] })).plaintext
    const chatToken = (await issueAccessToken({ name: 'chat', surfaces: ['openai-chat'] })).plaintext
    const sendEdit = (token: string) => {
      const data = new FormData()
      data.set('model', `openai,${model}`)
      data.set('prompt', 'Make the lantern blue')
      data.append('image[]', new Blob(['image content'], { type: 'image/png' }), 'lantern.png')
      return app.request('/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: data
      })
    }
    expect((await sendEdit(chatToken)).status).toBe(401)
    const edits: Array<{ url: string; key: string | null; body: FormData }> = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (!(init?.body instanceof FormData)) throw new Error('Expected multipart edit')
        edits.push({ url: String(input), key: new Headers(init.headers).get('authorization'), body: init.body })
        return json(payload)
      },
      { preconnect: ORIGINAL_FETCH.preconnect }
    )
    const response = await sendEdit(imageToken)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(payload)
    expect(edits.map(({ url, key, body }) => [url, key, body.get('model')])).toEqual([
      ['https://api.openai.com/v1/images/edits', 'Bearer upstream-key', model]
    ])
    const file = edits[0].body.get('image[]')
    if (!(file instanceof File)) throw new Error('Expected the uploaded image')
    expect(await file.text()).toBe('image content')
  })

  test.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    'edits %s only on enabled API key targets, including when a subscription offers the same model',
    async (model) => {
      const db = getPrismaClient()
      const subscription = await createProvider()
      if (model !== MODEL) await db.model.create({ data: { providerId: subscription.id, name: model, enabled: true } })
      await createAccount(subscription.id, 'legacy')
      const provider = await db.provider.create({
        data: { name: 'openai', apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'edit-key', enabled: true }
      })
      const row = await db.model.create({ data: { providerId: provider.id, name: model, enabled: false } })
      const token = (await issueAccessToken({ name: 'editor', surfaces: ['openai-images'] })).plaintext
      const sendEdit = (bearer: string, target = model) => {
        const form = new FormData()
        form.set('model', target)
        form.set('prompt', 'Open both eyes')
        form.set('quality', 'max')
        form.set('size', '1312x1200')
        for (const label of ['first', 'second']) form.append('image[]', new Blob([label]), label + '.png')
        return app.request('/v1/images/edits', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + bearer },
          body: form
        })
      }
      const submitted: string[][] = []
      globalThis.fetch = Object.assign(
        async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const form = init?.body
          if (!(form instanceof FormData)) throw new Error('Expected image edit')
          const files = await Promise.all(
            form.getAll('image[]').map((file) => (typeof file === 'string' ? file : file.text()))
          )
          submitted.push([
            String(url),
            String(new Headers(init?.headers).get('authorization')),
            String(form.get('model')),
            String(form.get('quality')),
            String(form.get('size')),
            ...files
          ])
          return json(payload)
        },
        { preconnect: ORIGINAL_FETCH.preconnect }
      )
      expect((await sendEdit(token)).status).toBe(400)
      await db.model.update({ where: { id: row.id }, data: { enabled: true } })
      expect((await sendEdit(token, 'codex,' + model)).status).toBe(400)
      const restricted = (
        await issueAccessToken({
          name: 'sub only',
          surfaces: ['openai-images'],
          policy: { ...DEFAULT_TOKEN_POLICY, providerMode: 'subscription_only' }
        })
      ).plaintext
      expect((await sendEdit(restricted)).status).toBe(403)
      expect((await sendEdit(token)).status).toBe(200)
      await updateSurface({ surface: 'openai-images', deniedTargets: ['openai,' + model] })
      expect((await sendEdit(token)).status).toBe(403)
      expect(submitted).toEqual([
        ['https://api.openai.com/v1/images/edits', 'Bearer edit-key', model, 'max', '1312x1200', 'first', 'second']
      ])
    }
  )

  test('forwards JSON file references and enforces the image surface denial', async () => {
    const db = getPrismaClient()
    const provider = await db.provider.create({
      data: { name: 'openai', apiBaseUrl: 'https://api.openai.com/v1/responses', apiKey: 'upstream-key', enabled: true }
    })
    const model = 'gpt-image-2.6-sunburst'
    await db.model.create({ data: { providerId: provider.id, name: model, enabled: true } })
    const token = (await issueAccessToken({ name: 'edit', surfaces: ['openai-images'] })).plaintext
    const sendEdit = (body: unknown) =>
      app.request('/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    const body = {
      model: `openai,${model}`,
      prompt: 'Make it blue',
      images: [{ file_id: 'file-original' }],
      mask: { file_id: 'file-mask' }
    }
    const sent: unknown[] = []
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)))
        return json(payload)
      },
      { preconnect: ORIGINAL_FETCH.preconnect }
    )
    expect((await sendEdit({ ...body, images: [] })).status).toBe(400)
    expect((await sendEdit({ ...body, stream: 'true' })).status).toBe(400)
    expect((await sendEdit(body)).status).toBe(200)
    expect(sent).toEqual([{ ...body, model }])
    await updateSurface({ surface: 'openai-images', deniedTargets: [body.model] })
    expect((await sendEdit(body)).status).toBe(403)
    expect(sent).toHaveLength(1)
  })

  test.each(['json', 'multipart'])(
    'relays %s edit events before completion and accounts for usage once',
    async (format) => {
      const db = getPrismaClient()
      const model = 'gpt-image-2.6-flare'
      await db.provider.create({
        data: {
          name: 'openai',
          apiBaseUrl: 'https://api.openai.com/v1/responses',
          apiKey: 'upstream-key',
          enabled: true,
          models: { create: [{ name: model, enabled: true }] }
        }
      })
      const token = await issueAccessToken({ name: 'stream edit', surfaces: ['openai-images'] })
      const encoder = new TextEncoder()
      const partial = 'event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","b64_json":"YQ=="}\n\n'
      const complete = `data: ${JSON.stringify({ type: 'image_edit.completed', b64_json: 'Yg==', usage: payload.usage })}\r\n\r\n`
      const { readable, writable } = new TransformStream<Uint8Array>()
      const writer = writable.getWriter()
      globalThis.fetch = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream')
          if (init?.body instanceof FormData) {
            expect(init.body.get('model')).toBe(model)
            expect(init.body.get('stream')).toBe('true')
            expect(init.body.get('partial_images')).toBe('1')
          } else {
            expect(JSON.parse(String(init?.body))).toMatchObject({ model, stream: true, partial_images: 1 })
          }
          return new Response(readable, { headers: { 'content-type': 'text/event-stream' } })
        },
        { preconnect: ORIGINAL_FETCH.preconnect }
      )
      const form = new FormData()
      form.set('model', model)
      form.set('prompt', 'Make it blue')
      form.set('stream', 'true')
      form.set('partial_images', '1')
      form.set('image', new Blob(['image'], { type: 'image/png' }), 'original.png')
      const response = await app.request('/v1/images/edits', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.plaintext}`,
          ...(format === 'json' ? { 'content-type': 'application/json' } : {})
        },
        body:
          format === 'multipart'
            ? form
            : JSON.stringify({
                model,
                prompt: 'Make it blue',
                images: [{ file_id: 'file-original' }],
                stream: true,
                partial_images: 1
              })
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Expected an edit stream')
      const decoder = new TextDecoder()
      const transfer = async (chunk: string) => {
        const write = writer.write(encoder.encode(chunk))
        expect(decoder.decode((await reader.read()).value)).toBe(chunk)
        await write
      }
      await transfer(partial)
      const finalChunk = 22
      await transfer(complete.slice(0, finalChunk))
      await transfer(complete.slice(finalChunk))
      await transfer(complete)
      const close = writer.close()
      expect((await reader.read()).done).toBe(true)
      await close
      const rows = await db.requestLog.findMany({ where: { accessTokenId: token.token.id } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ model, inputTokens: 18, outputTokens: 343 })
    }
  )

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

  describe('a token on a plan', () => {
    const issueOnPlan = async (models: string[], defaultModel = models[0]) => {
      const plan = await getPrismaClient().plan.create({ data: { name: `p-${Math.random()}`, models, defaultModel } })
      return (await issueAccessToken({ name: 'image', surfaces: ['openai-images'], planId: plan.id })).plaintext
    }

    test('generates with a model the plan lists', async () => {
      const provider = await createProvider()
      await createAccount(provider.id, 'a')
      const token = await issueOnPlan([`codex,${MODEL}`])
      expect((await send({ model: `codex,${MODEL}`, prompt: 'x' }, token)).status).toBe(200)
      expect((await send({ model: MODEL, prompt: 'x' }, token)).status).toBe(200)
      expect(calls).toHaveLength(2)
    })

    test('refuses a model the plan does not list with 403 and never dispatches', async () => {
      const provider = await createProvider()
      await createAccount(provider.id, 'a')
      const token = await issueOnPlan(['anthropic,claude-sonnet-5'])
      const result = await send({ model: `codex,${MODEL}`, prompt: 'x' }, token)
      expect(result.status).toBe(403)
      const envelope = await result.json()
      expect(envelope.error.type).toBe('permission_error')
      expect(envelope.error.message).toContain(`Model "codex,${MODEL}" is not allowed for this token`)
      expect(calls).toHaveLength(0)
    })
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

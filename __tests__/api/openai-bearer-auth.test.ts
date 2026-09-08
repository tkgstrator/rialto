/**
 * Auth on the /v1 surfaces.
 *
 * Two things are being protected here and they are independent:
 *
 *   1. The wire contract promised to OpenAI clients — Bearer only on
 *      /v1/chat/completions, /v1/responses and /v1/models (`x-api-key`
 *      is an Anthropic convention and is rejected there), OpenAI-shaped
 *      401 bodies, and /v1/messages still accepting both headers with
 *      an Anthropic-shaped 401.
 *
 *   2. Which credential opens them. That changed: the envelope APIKEY
 *      is no longer accepted on /v1 at all. At the edge this path is a
 *      Bypass policy, so whatever passes here is the only thing in
 *      front of the operator's credits — and a master key there could
 *      not be revoked without cutting off every client, and no request
 *      log could say whose it was.
 *
 * Built as a minimal Hono app in-process so no server needs to start.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { getPrismaClient } from '../../src/db/client'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { HAS_DB, teardownPrisma } from '../db/helpers'

const BOOTSTRAP = 'bootstrap-key-12345'
const prevKey = process.env.APIKEY

function buildApp(): Hono {
  const app = new Hono()
  // Mirror src/index.ts: one gate per registry-derived prefix, which
  // dispatches to the credential convention the surface declares. This
  // replaced a hand-written path list here and there — if the registry
  // and the wire contract below ever disagree, this is where it shows.
  for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
  const ok = (c: { text: (s: string) => Response }): Response => c.text('ok')
  app.get('/v1/models', ok)
  app.post('/v1/messages/count_tokens', ok)
  app.post('/v1/chat/completions', ok)
  app.post('/v1/responses', ok)
  app.post('/v1/messages', ok)
  return app
}

const call = (app: Hono, path: string, headers: Record<string, string>, method = 'POST') =>
  app.fetch(new Request(`http://local${path}`, { method, headers }))

describe.skipIf(!HAS_DB)('/v1 auth', () => {
  let token = ''

  beforeEach(async () => {
    process.env.APIKEY = BOOTSTRAP
    await getPrismaClient().accessToken.deleteMany({})
    invalidateTokenCache()
    token = (await issueAccessToken({ name: 'test' })).plaintext
  })

  afterEach(() => {
    if (prevKey === undefined) delete process.env.APIKEY
    else process.env.APIKEY = prevKey
  })

  afterAll(teardownPrisma)

  describe('the credential', () => {
    test('an issued token opens the proxy', async () => {
      const res = await call(buildApp(), '/v1/chat/completions', { authorization: `Bearer ${token}` })
      expect(res.status).toBe(200)
    })

    test('the envelope bootstrap key does not', async () => {
      // The regression this file exists to catch. A master key here
      // would be unrevocable and unattributable.
      const app = buildApp()
      expect((await call(app, '/v1/chat/completions', { authorization: `Bearer ${BOOTSTRAP}` })).status).toBe(401)
      expect((await call(app, '/v1/messages', { 'x-api-key': BOOTSTRAP })).status).toBe(401)
    })

    test('a token scoped to one surface is refused on another', async () => {
      const scoped = (await issueAccessToken({ name: 'chat only', surfaces: ['openai-chat'] })).plaintext
      const app = buildApp()
      expect((await call(app, '/v1/chat/completions', { authorization: `Bearer ${scoped}` })).status).toBe(200)
      expect((await call(app, '/v1/responses', { authorization: `Bearer ${scoped}` })).status).toBe(401)
    })

    test('a scoped token can still read the catalog', async () => {
      // /v1/models is a catalog read, not a completion surface — it
      // spends nothing and is deliberately absent from the surface
      // registry. Refusing it to a scoped token breaks every OpenAI SDK
      // client, which lists models before it calls one, and the scope it
      // was given says nothing about whether it may read the menu.
      const scoped = (await issueAccessToken({ name: 'chat only', surfaces: ['openai-chat'] })).plaintext
      const app = buildApp()
      expect((await call(app, '/v1/models', { authorization: `Bearer ${scoped}` }, 'GET')).status).toBe(200)
      // The Anthropic-side equivalent: a pre-flight size check, also not
      // a surface and also not a thing the scope is about.
      expect((await call(app, '/v1/messages/count_tokens', { 'x-api-key': scoped })).status).toBe(200)
    })

    test('a bogus value is refused', async () => {
      expect((await call(buildApp(), '/v1/chat/completions', { authorization: 'Bearer nope' })).status).toBe(401)
    })
  })

  describe('the OpenAI wire contract', () => {
    test('rejects x-api-key even when the token itself is valid', async () => {
      // x-api-key is an Anthropic convention; accepting it here would
      // leak the two conventions into each other.
      const res = await call(buildApp(), '/v1/chat/completions', { 'x-api-key': token })
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: { type?: string; code?: string } }
      expect(body.error?.type).toBe('invalid_request_error')
      expect(body.error?.code).toBe('invalid_api_key')
    })

    test('/v1/responses is guarded the same way', async () => {
      const app = buildApp()
      expect((await call(app, '/v1/responses', { 'x-api-key': token })).status).toBe(401)
      expect((await call(app, '/v1/responses', { authorization: `Bearer ${token}` })).status).toBe(200)
    })

    test('GET /v1/models is guarded the same way', async () => {
      const app = buildApp()
      expect((await call(app, '/v1/models', { 'x-api-key': token }, 'GET')).status).toBe(401)
      expect((await call(app, '/v1/models', { authorization: `Bearer ${token}` }, 'GET')).status).toBe(200)
    })
  })

  describe('the Anthropic wire contract on /v1/messages', () => {
    test('accepts x-api-key, which is what Claude Code sends', async () => {
      expect((await call(buildApp(), '/v1/messages', { 'x-api-key': token })).status).toBe(200)
    })

    test('also accepts Authorization: Bearer', async () => {
      expect((await call(buildApp(), '/v1/messages', { authorization: `Bearer ${token}` })).status).toBe(200)
    })

    test('401 envelope stays Anthropic-shaped', async () => {
      const res = await call(buildApp(), '/v1/messages', {})
      expect(res.status).toBe(401)
      const body = (await res.json()) as { type?: string; error?: { type?: string } }
      expect(body.type).toBe('error')
      expect(body.error?.type).toBe('authentication_error')
    })
  })
})

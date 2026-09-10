/**
 * Auth on the Gemini surface (`/v1beta/models/*`).
 *
 * The surface is new, so this file is written as the list of ways in.
 * Each case is either a door that must open or a door that must not:
 *
 *   - Google's own two conventions (`x-goog-api-key`, `?key=`) must
 *     open it with an issued token, because that is what a Gemini
 *     client sends and nothing else will do.
 *   - A value left in the environment as the retired envelope APIKEY must
 *     NOT, exactly as on the other /v1 surfaces. At the edge this path is
 *     a Bypass policy, so the gate here is the only thing in front of the
 *     operator's credits, and a master key there is unrevocable and
 *     unattributable.
 *   - Surface scoping must hold on a globbed path, which is the one
 *     place it could quietly stop working: the scope check resolves the
 *     surface from the request path, and gemini's is a prefix match.
 *   - A 401 must answer in google.rpc.Status shape, or the GenAI SDKs
 *     report a parse failure instead of an auth failure.
 *
 * Built as a minimal Hono app in-process, mirroring how `index.ts`
 * mounts the gate, so no server needs to start.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { getPrismaClient } from '../../src/db/client'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'
import { invalidateTokenCache, issueAccessToken, revokeAccessToken } from '../../src/services/access-token-service'
import { HAS_DB, teardownPrisma } from '../db/helpers'

const LEFTOVER = 'leftover-key-12345'
const GENERATE = '/v1beta/models/gemini-3-pro:generateContent'
const prevKey = process.env.APIKEY

function buildApp(): Hono {
  const app = new Hono()
  // Same mounting index.ts does: one gate per registry-derived prefix.
  for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
  const ok = (c: { text: (s: string) => Response }): Response => c.text('ok')
  app.post('/v1beta/models/:modelAndAction', ok)
  app.post('/v1/messages', ok)
  app.post('/v1/chat/completions', ok)
  return app
}

const call = (app: Hono, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://local${path}`, { method: 'POST', headers }))

describe.skipIf(!HAS_DB)('/v1beta auth', () => {
  let token = ''

  beforeEach(async () => {
    process.env.APIKEY = LEFTOVER
    await getPrismaClient().accessToken.deleteMany({})
    invalidateTokenCache()
    token = (await issueAccessToken({ name: 'gemini test' })).plaintext
  })

  afterEach(() => {
    if (prevKey === undefined) delete process.env.APIKEY
    else process.env.APIKEY = prevKey
  })

  afterAll(teardownPrisma)

  describe('doors that must open', () => {
    test('x-goog-api-key, which is what the Google GenAI SDKs send', async () => {
      expect((await call(buildApp(), GENERATE, { 'x-goog-api-key': token })).status).toBe(200)
    })

    test('?key=, which is what the REST docs send', async () => {
      const app = buildApp()
      const res = await app.fetch(new Request(`http://local${GENERATE}?key=${token}`, { method: 'POST' }))
      expect(res.status).toBe(200)
    })

    test('Authorization: Bearer, the one header every client family can send', async () => {
      expect((await call(buildApp(), GENERATE, { authorization: `Bearer ${token}` })).status).toBe(200)
    })

    test('the streaming action is the same surface and the same gate', async () => {
      const streaming = '/v1beta/models/gemini-3-pro:streamGenerateContent'
      expect((await call(buildApp(), streaming, { 'x-goog-api-key': token })).status).toBe(200)
    })
  })

  describe('doors that must not open', () => {
    test('no credential at all', async () => {
      expect((await call(buildApp(), GENERATE)).status).toBe(401)
    })

    test('a leftover APIKEY value', async () => {
      // The regression this file exists to catch, and the reason the
      // gemini surface could not simply reuse the admin gate.
      const app = buildApp()
      expect((await call(app, GENERATE, { 'x-goog-api-key': LEFTOVER })).status).toBe(401)
      expect((await call(app, GENERATE, { authorization: `Bearer ${LEFTOVER}` })).status).toBe(401)
    })

    test('a revoked token', async () => {
      const issued = await issueAccessToken({ name: 'to be revoked' })
      await revokeAccessToken(issued.token.id)
      expect((await call(buildApp(), GENERATE, { 'x-goog-api-key': issued.plaintext })).status).toBe(401)
    })

    test('x-api-key, which is the Anthropic convention', async () => {
      // Accepting it here would leak two conventions into each other and
      // invite reusing one key across surfaces.
      expect((await call(buildApp(), GENERATE, { 'x-api-key': token })).status).toBe(401)
    })

    test('a token scoped to another surface', async () => {
      const scoped = (await issueAccessToken({ name: 'chat only', surfaces: ['openai-chat'] })).plaintext
      expect((await call(buildApp(), GENERATE, { 'x-goog-api-key': scoped })).status).toBe(401)
    })

    test('a gemini-scoped token on another surface', async () => {
      // The mirror of the case above: scoping must bind in both
      // directions, and the globbed path must not widen it.
      const scoped = (await issueAccessToken({ name: 'gemini only', surfaces: ['gemini-generate'] })).plaintext
      const app = buildApp()
      expect((await call(app, GENERATE, { 'x-goog-api-key': scoped })).status).toBe(200)
      expect((await call(app, '/v1/messages', { 'x-api-key': scoped })).status).toBe(401)
    })

    test('?key= is not honoured on any other surface', async () => {
      // URL-borne secrets are otherwise refused outright; the gemini
      // surface is the single documented exception because Google's wire
      // convention leaves no alternative.
      const app = buildApp()
      const res = await app.fetch(new Request(`http://local/v1/chat/completions?key=${token}`, { method: 'POST' }))
      expect(res.status).toBe(401)
    })
  })

  describe('the wire contract', () => {
    test('401 answers in google.rpc.Status shape', async () => {
      const res = await call(buildApp(), GENERATE)
      expect(res.status).toBe(401)
      const body = (await res.json()) as { error?: { code?: number; status?: string; message?: string } }
      expect(body.error?.code).toBe(401)
      expect(body.error?.status).toBe('UNAUTHENTICATED')
      expect(typeof body.error?.message).toBe('string')
    })

    test('the neighbouring surfaces keep their own 401 envelopes', async () => {
      // The dispatcher replaced a hand-written path list; if it picked
      // the wrong gate, this is where it would show.
      const app = buildApp()
      const anthropic = (await (await call(app, '/v1/messages')).json()) as { type?: string }
      expect(anthropic.type).toBe('error')
      const openai = (await (await call(app, '/v1/chat/completions')).json()) as {
        error?: { code?: string }
      }
      expect(openai.error?.code).toBe('invalid_api_key')
    })
  })
})

/**
 * The live-updates stream authenticates like every other /api route.
 *
 * It used to carry its own inline check against the envelope key,
 * because EventSource cannot set headers and the credential arrived as a
 * query parameter. That copy knew nothing about the local exemption or
 * Cloudflare Access, so on a machine where every other /api call
 * succeeded, live updates alone returned 401.
 *
 * The key is gone now, and with it the `apikey` query parameter this one
 * path used to accept. These tests pin that the stream is gated by the
 * shared gate, and that a key left over from an older install opens
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { adminAuth } from '../../src/api/api-key-auth'
import { requestLogsRoute } from '../../src/api/request-logs/route'

const LEFTOVER = 'a-key-left-in-the-environment'
const PATH = '/api/request-logs/events'
const saved = { key: process.env.APIKEY, trust: process.env.RIALTO_TRUST_LOCAL }

function buildApp(): Hono {
  const app = new Hono()
  app.use('/api/*', adminAuth)
  app.route('/', requestLogsRoute)
  return app
}

// The handler answers with an open stream, so anything that is not a 401
// means the request got through. Aborting keeps the stream from holding
// the test open.
async function status(url: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await buildApp().fetch(new Request(`http://local${url}`, { headers }))
  await res.body?.cancel()
  return res.status
}

beforeEach(() => {
  // An install upgraded from a build that accepted the key may still
  // have one in its environment.
  process.env.APIKEY = LEFTOVER
  delete process.env.RIALTO_TRUST_LOCAL
})

afterEach(() => {
  if (saved.key === undefined) delete process.env.APIKEY
  else process.env.APIKEY = saved.key
  if (saved.trust === undefined) delete process.env.RIALTO_TRUST_LOCAL
  else process.env.RIALTO_TRUST_LOCAL = saved.trust
})

describe('GET /api/request-logs/events', () => {
  test('opens for a browser on this machine, with no credential', async () => {
    // The regression: this returned 401 while every sibling route
    // returned 200 on the same host.
    expect(await status(PATH, { host: 'localhost:16175' })).not.toBe(401)
  })

  test('rejects a remote request with no credential', async () => {
    expect(await status(PATH, { host: 'rialto.example.com' })).toBe(401)
  })

  test('the old query parameter opens nothing, even carrying the old key', async () => {
    expect(await status(`${PATH}?apikey=${LEFTOVER}`, { host: 'rialto.example.com' })).toBe(401)
  })

  test('nor does the old key as a header', async () => {
    expect(await status(PATH, { host: 'rialto.example.com', 'x-api-key': LEFTOVER })).toBe(401)
    expect(await status(PATH, { host: 'rialto.example.com', authorization: `Bearer ${LEFTOVER}` })).toBe(401)
  })

  test('a tunnelled request is not local even when the Host says localhost', async () => {
    expect(await status(PATH, { host: 'localhost:16175', 'cf-connecting-ip': '203.0.113.7' })).toBe(401)
  })

  test('with the local exemption switched off, a browser on this machine is refused too', async () => {
    // RIALTO_TRUST_LOCAL=false with Access unconfigured leaves nothing
    // that can reach /api/* — the state boot warns about.
    process.env.RIALTO_TRUST_LOCAL = 'false'
    expect(await status(PATH, { host: 'localhost:16175' })).toBe(401)
  })
})

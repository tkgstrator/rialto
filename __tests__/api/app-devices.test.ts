/**
 * The two app-registration endpoints, wired the way src/index.ts wires
 * them: mounted ahead of the /v1 token gate, since an install asking for
 * its first token has none to present.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { appDevicesRoute } from '../../src/api/v1/app-devices'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'

const ENV_KEYS = ['RIALTO_APP_ATTEST_APP_ID', 'RIALTO_APP_FREE_MODEL'] as const
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function buildApp(): Hono {
  const app = new Hono()
  app.route('/', appDevicesRoute)
  for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
  return app
}

const post = (path: string, body: unknown = {}) =>
  buildApp().fetch(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

const configure = (): void => {
  process.env.RIALTO_APP_ATTEST_APP_ID = 'TEAMID1234.jp.example.app'
  process.env.RIALTO_APP_FREE_MODEL = 'openai,gpt-cheap'
}

beforeEach(() => {
  ENV_KEYS.forEach((key) => {
    delete process.env[key]
  })
})

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe('/v1/app/*', () => {
  test('answers 503 until the operator configures registration', async () => {
    expect((await post('/v1/app/challenge')).status).toBe(503)
    expect((await post('/v1/app/devices')).status).toBe(503)
  })

  test('hands out a challenge without an access token', async () => {
    configure()
    const res = await post('/v1/app/challenge')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ expires_in: 300 })
    expect(typeof body.challenge).toBe('string')
  })

  test('refuses a registration body that is not the three strings', async () => {
    configure()
    const res = await post('/v1/app/devices', { key_id: 'k' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_body' } })
  })

  test('refuses an unverifiable attestation without saying which check failed', async () => {
    configure()
    const res = await post('/v1/app/devices', { key_id: 'k', attestation: 'AAAA', challenge: 'never-issued' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'attestation_rejected' } })
  })
})

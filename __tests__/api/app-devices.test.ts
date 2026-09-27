/**
 * The two app-registration endpoints, wired the way src/index.ts wires
 * them: mounted ahead of the /v1 token gate, since an install asking for
 * its first token has none to present. Whether they are open is decided by
 * the authorized apps table.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { appDevicesRoute } from '../../src/api/v1/app-devices'
import { getPrismaClient } from '../../src/db/client'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'
import { createApp } from '../../src/services/authorized-app-service'
import { createPlan } from '../../src/services/plan-service'
import { HAS_DB, teardownPrisma } from '../db/helpers'

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

async function authorize(): Promise<void> {
  const plan = await createPlan({
    name: 'Free',
    models: ['codex,gpt-6-luna'],
    defaultModel: 'codex,gpt-6-luna',
    dailyRequestLimit: 100
  })
  if (!plan.ok) throw new Error(plan.message)
  await createApp({
    name: 'Connect',
    appleAppId: 'TEAMID1234.jp.example.app',
    planId: plan.plan.id,
    allowDevelopment: false
  })
}

describe.skipIf(!HAS_DB)('/v1/app/*', () => {
  beforeEach(async () => {
    const prisma = getPrismaClient()
    await prisma.appDevice.deleteMany({})
    await prisma.accessToken.deleteMany({})
    await prisma.authorizedApp.deleteMany({})
    await prisma.plan.deleteMany({})
  })

  afterAll(teardownPrisma)

  test('answers 503 until an app is authorized', async () => {
    expect((await post('/v1/app/challenge')).status).toBe(503)
    expect((await post('/v1/app/devices')).status).toBe(503)
  })

  test('hands out a challenge without an access token', async () => {
    await authorize()
    const res = await post('/v1/app/challenge')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ expires_in: 300 })
    expect(typeof body.challenge).toBe('string')
  })

  test('refuses a registration body that is not the three strings', async () => {
    await authorize()
    const res = await post('/v1/app/devices', { key_id: 'k' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_body' } })
  })

  test('refuses an unverifiable attestation without saying which check failed', async () => {
    await authorize()
    const res = await post('/v1/app/devices', { key_id: 'k', attestation: 'AAAA', challenge: 'never-issued' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'attestation_rejected' } })
  })
})

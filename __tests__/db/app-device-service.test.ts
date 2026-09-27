/**
 * App installs registering with App Attest, and the plans and authorized
 * apps that decide what they get.
 *
 * Uses the throwaway-CA fixture that verify-attestation.test.ts documents;
 * the root is the only policy input overridden.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'
import {
  invalidateTokenCache,
  issueAccessToken,
  listAccessTokens,
  resolveAccessToken
} from '../../src/services/access-token-service'
import {
  __clearChallengesForTests,
  __seedChallengeForTests,
  issueChallenge,
  registerDevice,
  registrationOpen
} from '../../src/services/app-device-service'
import { createApp, listApps, listDevices, updateApp } from '../../src/services/authorized-app-service'
import { createPlan, deletePlan, planProblem, updatePlan } from '../../src/services/plan-service'
import { HAS_DB, teardownPrisma } from './helpers'

const CaseSchema = z.object({ keyId: z.string().nonempty(), attestation: z.string().nonempty() })
const FixtureSchema = z.object({
  appId: z.string().nonempty(),
  challenge: z.string().nonempty(),
  rootPem: z.string().nonempty(),
  production: CaseSchema
})
const loaded = FixtureSchema.safeParse(
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/app-attest.json'), 'utf8'))
)
if (!loaded.success) throw new Error(`app-attest fixture is malformed: ${loaded.error.message}`)
const fixture = loaded.data

const override = { root: new X509Certificate(fixture.rootPem), now: dayjs('2030-01-01T00:00:00Z').toDate() }

const register = () =>
  registerDevice(
    { keyId: fixture.production.keyId, attestation: fixture.production.attestation, challenge: fixture.challenge },
    override
  )

const FREE = {
  name: 'Free',
  models: ['codex,gpt-6-luna', 'google,gemini-3-flash'],
  defaultModel: 'codex,gpt-6-luna',
  dailyRequestLimit: 2
}

async function reset(): Promise<void> {
  const prisma = getPrismaClient()
  await prisma.appDevice.deleteMany({})
  await prisma.accessToken.deleteMany({})
  await prisma.authorizedApp.deleteMany({})
  await prisma.plan.deleteMany({})
  invalidateTokenCache()
  __clearChallengesForTests()
}

/** A Free plan and the fixture's app on it. */
async function authorizeFixtureApp(): Promise<{ planId: string; appId: string }> {
  const plan = await createPlan(FREE)
  if (!plan.ok) throw new Error(plan.message)
  const app = await createApp({
    name: 'Connect',
    appleAppId: fixture.appId,
    planId: plan.plan.id,
    allowDevelopment: false
  })
  if (!app.ok) throw new Error(app.message)
  return { planId: plan.plan.id, appId: app.app.id }
}

async function registered(): Promise<string> {
  __seedChallengeForTests(fixture.challenge)
  const result = await register()
  if (!result.ok) throw new Error(result.reason)
  return result.apiKey
}

describe('planProblem', () => {
  test('accepts a plan whose default is one of its models', () => {
    expect(planProblem(FREE)).toBeNull()
    expect(planProblem({ ...FREE, dailyRequestLimit: null })).toBeNull()
  })

  test('refuses a default outside the list, an empty list, a repeat and a bad cap', () => {
    expect(planProblem({ ...FREE, defaultModel: 'codex,gpt-6-astra' })).not.toBeNull()
    expect(planProblem({ ...FREE, models: [] })).not.toBeNull()
    expect(planProblem({ ...FREE, models: ['codex,gpt-6-luna', 'codex,gpt-6-luna'] })).not.toBeNull()
    expect(planProblem({ ...FREE, dailyRequestLimit: 0 })).not.toBeNull()
  })
})

describe('issueChallenge', () => {
  test('hands out a fresh, unguessable challenge each time', () => {
    const a = issueChallenge()
    const b = issueChallenge()
    expect(a.challenge).not.toBe(b.challenge)
    expect(Buffer.from(a.challenge, 'base64url').length).toBe(32)
  })
})

describe.skipIf(!HAS_DB)('registerDevice', () => {
  beforeEach(reset)
  afterAll(teardownPrisma)

  test('registration is closed until an app is authorized and on', async () => {
    expect(await registrationOpen()).toBe(false)
    const { appId } = await authorizeFixtureApp()
    expect(await registrationOpen()).toBe(true)
    await updateApp(appId, { enabled: false })
    expect(await registrationOpen()).toBe(false)
  })

  test('refuses a challenge the server never issued', async () => {
    await authorizeFixtureApp()
    expect(await register()).toEqual({ ok: false, status: 400, reason: 'unknown or expired challenge' })
  })

  test('mints a token on its app’s plan and ties the install to the app', async () => {
    const { planId, appId } = await authorizeFixtureApp()
    __seedChallengeForTests(fixture.challenge)
    const result = await register()
    expect(result).toMatchObject({ ok: true, plan: 'Free', model: 'codex,gpt-6-luna', dailyRequestLimit: 2 })
    if (!result.ok) return

    expect(await resolveAccessToken(result.apiKey)).toMatchObject({
      surfaces: ['openai-responses', 'openai-chat'],
      plan: { models: FREE.models, defaultModel: 'codex,gpt-6-luna', dailyRequestLimit: 2 }
    })
    const device = await getPrismaClient().appDevice.findUnique({
      where: { keyId: fixture.production.keyId },
      include: { accessToken: true }
    })
    expect(device?.authorizedAppId).toBe(appId)
    expect(device?.accessToken.planId).toBe(planId)
    expect(device?.publicKey.length).toBe(65)
  })

  test('refuses an attestation for an app nobody authorized', async () => {
    const plan = await createPlan(FREE)
    if (!plan.ok) throw new Error(plan.message)
    await createApp({
      name: 'Other',
      appleAppId: 'OTHERTEAM1.jp.example.other',
      planId: plan.plan.id,
      allowDevelopment: true
    })
    __seedChallengeForTests(fixture.challenge)
    expect(await register()).toEqual({
      ok: false,
      status: 400,
      reason: 'attestation is for an app that is not authorized'
    })
  })

  test('a challenge is good for one registration only', async () => {
    await authorizeFixtureApp()
    __seedChallengeForTests(fixture.challenge)
    await register()
    expect(await register()).toEqual({ ok: false, status: 400, reason: 'unknown or expired challenge' })
  })

  test('one attested key cannot mint a second token', async () => {
    await authorizeFixtureApp()
    await registered()
    __seedChallengeForTests(fixture.challenge)
    expect(await register()).toEqual({ ok: false, status: 409, reason: 'this key is already registered' })
    expect(await getPrismaClient().accessToken.count()).toBe(1)
  })

  test('turning the app off stops its tokens, and on brings them back', async () => {
    const { appId } = await authorizeFixtureApp()
    const apiKey = await registered()
    await updateApp(appId, { enabled: false })
    expect(await resolveAccessToken(apiKey)).toBeNull()
    await updateApp(appId, { enabled: true })
    expect(await resolveAccessToken(apiKey)).not.toBeNull()
  })

  test('app tokens stay off the Tokens tab, not off Activity', async () => {
    await authorizeFixtureApp()
    await registered()
    await issueAccessToken({ name: 'operator' })
    expect((await listAccessTokens({ manualOnly: true })).map((token) => token.name)).toEqual(['operator'])
    // Activity still sees them all, so its spend shares add up.
    expect(await listAccessTokens()).toHaveLength(2)
  })

  test('the app row and its device page count the install', async () => {
    const { appId } = await authorizeFixtureApp()
    await registered()
    const [app] = await listApps()
    expect(app).toMatchObject({ name: 'Connect', deviceCount: 1, plan: { name: 'Free' } })
    const page = await listDevices(appId)
    expect(page.total).toBe(1)
    expect(page.devices[0]).toMatchObject({
      keyPrefix: fixture.production.keyId.slice(0, 8),
      environment: 'production',
      plan: { name: 'Free' },
      requestsToday: 0,
      dailyRequestLimit: 2
    })
    expect((await listDevices(appId, { query: 'zzzz' })).total).toBe(0)
  })
})

describe.skipIf(!HAS_DB)('plans and apps', () => {
  beforeEach(reset)
  afterAll(teardownPrisma)

  test('a plan name is unique', async () => {
    await createPlan(FREE)
    expect(await createPlan(FREE)).toMatchObject({ ok: false, reason: 'duplicate-name' })
  })

  test('a plan in use cannot be deleted; an unused one can', async () => {
    const { planId } = await authorizeFixtureApp()
    expect(await deletePlan(planId)).toMatchObject({ ok: false, reason: 'in-use' })
    const spare = await createPlan({ ...FREE, name: 'Spare' })
    if (!spare.ok) throw new Error(spare.message)
    expect(await deletePlan(spare.plan.id)).toEqual({ ok: true })
  })

  test('an edit is validated as a whole plan', async () => {
    const plan = await createPlan(FREE)
    if (!plan.ok) throw new Error(plan.message)
    // Dropping the default from the list without naming a new one is refused.
    expect(await updatePlan(plan.plan.id, { models: ['google,gemini-3-flash'] })).toMatchObject({
      ok: false,
      reason: 'invalid'
    })
  })

  test('an app needs a well-formed App ID and a real plan', async () => {
    const plan = await createPlan(FREE)
    if (!plan.ok) throw new Error(plan.message)
    const base = { name: 'X', planId: plan.plan.id, allowDevelopment: false }
    expect(await createApp({ ...base, appleAppId: 'jp.qleap.connect' })).toMatchObject({ reason: 'invalid' })
    expect(await createApp({ ...base, appleAppId: fixture.appId, planId: 'missing' })).toMatchObject({
      reason: 'unknown-plan'
    })
    await createApp({ ...base, appleAppId: fixture.appId })
    expect(await createApp({ ...base, appleAppId: fixture.appId })).toMatchObject({ reason: 'duplicate' })
  })
})

describe.skipIf(!HAS_DB)('the daily cap at the /v1 gate', () => {
  beforeEach(reset)
  afterAll(teardownPrisma)

  const buildApp = (): Hono => {
    const app = new Hono()
    for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
    app.post('/v1/responses', (c) => c.text('ok'))
    app.get('/v1/models', (c) => c.text('ok'))
    app.post('/v1/audio/speech', (c) => c.text('ok'))
    return app
  }

  const call = (app: Hono, apiKey: string, path = '/v1/responses', method = 'POST') =>
    app.fetch(new Request(`http://local${path}`, { method, headers: { authorization: `Bearer ${apiKey}` } }))

  test('admits requests up to the plan’s cap, then answers 429 with Retry-After', async () => {
    await authorizeFixtureApp()
    const apiKey = await registered()
    const app = buildApp()

    expect((await call(app, apiKey)).status).toBe(200)
    expect((await call(app, apiKey)).status).toBe(200)
    const refused = await call(app, apiKey)
    expect(refused.status).toBe(429)
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(86_400)
    expect(await refused.json()).toMatchObject({ error: { code: 'daily_limit_exceeded' } })
  })

  test('raising the plan’s cap reaches a token already issued', async () => {
    const { planId } = await authorizeFixtureApp()
    const apiKey = await registered()
    const app = buildApp()
    await call(app, apiKey)
    await call(app, apiKey)
    expect((await call(app, apiKey)).status).toBe(429)
    await updatePlan(planId, { dailyRequestLimit: 10 })
    expect((await call(app, apiKey)).status).toBe(200)
  })

  test('listing models does not spend the allowance', async () => {
    await authorizeFixtureApp()
    const apiKey = await registered()
    const app = buildApp()
    const listings = await Promise.all(Array.from({ length: 3 }, () => call(app, apiKey, '/v1/models', 'GET')))
    expect(listings.map((res) => res.status)).toEqual([200, 200, 200])
    expect((await call(app, apiKey)).status).toBe(200)
  })

  test('an install’s token may speak its replies, and speaking does not spend the allowance', async () => {
    await authorizeFixtureApp()
    // Scoped to the two completion surfaces, as every install's token is.
    const apiKey = await registered()
    const app = buildApp()
    const spoken = await Promise.all(Array.from({ length: 3 }, () => call(app, apiKey, '/v1/audio/speech')))
    expect(spoken.map((res) => res.status)).toEqual([200, 200, 200])
    expect((await call(app, apiKey)).status).toBe(200)
  })

  test('a token with no plan is never counted', async () => {
    const { plaintext } = await issueAccessToken({ name: 'operator' })
    const app = buildApp()
    const statuses = await Promise.all(Array.from({ length: 5 }, () => call(app, plaintext)))
    expect(statuses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200])
    expect(await getPrismaClient().accessTokenDailyUsage.count()).toBe(0)
  })
})

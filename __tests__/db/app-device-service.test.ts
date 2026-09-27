/**
 * Registering an app install: attestation in, capped and pinned token out.
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
import { invalidateTokenCache, resolveAccessToken } from '../../src/services/access-token-service'
import {
  __clearChallengesForTests,
  __seedChallengeForTests,
  type AppDeviceConfig,
  issueChallenge,
  readAppDeviceConfig,
  registerDevice
} from '../../src/services/app-device-service'
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

const CONFIG: AppDeviceConfig = {
  appId: fixture.appId,
  allowDevelopment: false,
  freeModel: 'openai,gpt-cheap',
  freeDailyRequests: 2
}

const override = { root: new X509Certificate(fixture.rootPem), now: dayjs('2030-01-01T00:00:00Z').toDate() }

const register = () =>
  registerDevice(
    { keyId: fixture.production.keyId, attestation: fixture.production.attestation, challenge: fixture.challenge },
    CONFIG,
    override
  )

describe('readAppDeviceConfig', () => {
  test('is off until both the app id and the free model are set', () => {
    expect(readAppDeviceConfig({})).toBeNull()
    expect(readAppDeviceConfig({ RIALTO_APP_ATTEST_APP_ID: 'T.app' })).toBeNull()
    expect(readAppDeviceConfig({ RIALTO_APP_ATTEST_APP_ID: 'T.app', RIALTO_APP_FREE_MODEL: 'm' })).toEqual({
      appId: 'T.app',
      allowDevelopment: false,
      freeModel: 'm',
      freeDailyRequests: 100
    })
  })

  test('ignores a daily cap that is not a positive integer', () => {
    const config = readAppDeviceConfig({
      RIALTO_APP_ATTEST_APP_ID: 'T.app',
      RIALTO_APP_FREE_MODEL: 'm',
      RIALTO_APP_FREE_DAILY_REQUESTS: '-3'
    })
    expect(config?.freeDailyRequests).toBe(100)
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
  beforeEach(async () => {
    const prisma = getPrismaClient()
    await prisma.appDevice.deleteMany({})
    await prisma.accessToken.deleteMany({})
    invalidateTokenCache()
    __clearChallengesForTests()
  })

  afterAll(teardownPrisma)

  test('refuses a challenge the server never issued', async () => {
    expect(await register()).toEqual({ ok: false, status: 400, reason: 'unknown or expired challenge' })
  })

  test('mints a token pinned to the free model and capped per day', async () => {
    __seedChallengeForTests(fixture.challenge)
    const result = await register()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result).toMatchObject({ plan: 'free', model: 'openai,gpt-cheap', dailyRequestLimit: 2 })

    const token = await resolveAccessToken(result.apiKey)
    expect(token).toMatchObject({
      modelPin: 'openai,gpt-cheap',
      dailyRequestLimit: 2,
      surfaces: ['openai-responses', 'openai-chat']
    })
    const device = await getPrismaClient().appDevice.findUnique({ where: { keyId: fixture.production.keyId } })
    expect(device?.environment).toBe('production')
    expect(device?.publicKey.length).toBe(65)
  })

  test('a challenge is good for one registration only', async () => {
    __seedChallengeForTests(fixture.challenge)
    await register()
    expect(await register()).toEqual({ ok: false, status: 400, reason: 'unknown or expired challenge' })
  })

  test('one attested key cannot mint a second token', async () => {
    __seedChallengeForTests(fixture.challenge)
    await register()
    __seedChallengeForTests(fixture.challenge)
    expect(await register()).toEqual({ ok: false, status: 409, reason: 'this key is already registered' })
    expect(await getPrismaClient().accessToken.count()).toBe(1)
  })
})

describe.skipIf(!HAS_DB)('the daily cap at the /v1 gate', () => {
  beforeEach(async () => {
    const prisma = getPrismaClient()
    await prisma.appDevice.deleteMany({})
    await prisma.accessToken.deleteMany({})
    invalidateTokenCache()
    __clearChallengesForTests()
  })

  afterAll(teardownPrisma)

  const buildApp = (): Hono => {
    const app = new Hono()
    for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
    app.post('/v1/responses', (c) => c.text('ok'))
    app.get('/v1/models', (c) => c.text('ok'))
    return app
  }

  const call = (app: Hono, apiKey: string, path = '/v1/responses', method = 'POST') =>
    app.fetch(new Request(`http://local${path}`, { method, headers: { authorization: `Bearer ${apiKey}` } }))

  test('admits requests up to the cap, then answers 429 with Retry-After', async () => {
    __seedChallengeForTests(fixture.challenge)
    const result = await register()
    if (!result.ok) throw new Error(result.reason)
    const app = buildApp()

    expect((await call(app, result.apiKey)).status).toBe(200)
    expect((await call(app, result.apiKey)).status).toBe(200)
    const refused = await call(app, result.apiKey)
    expect(refused.status).toBe(429)
    const retryAfter = Number(refused.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(86_400)
    expect(await refused.json()).toMatchObject({ error: { code: 'daily_limit_exceeded' } })
  })

  test('listing models does not spend the allowance', async () => {
    __seedChallengeForTests(fixture.challenge)
    const result = await register()
    if (!result.ok) throw new Error(result.reason)
    const app = buildApp()

    const listings = await Promise.all(Array.from({ length: 3 }, () => call(app, result.apiKey, '/v1/models', 'GET')))
    expect(listings.map((res) => res.status)).toEqual([200, 200, 200])
    expect((await call(app, result.apiKey)).status).toBe(200)
  })

  test('an operator-issued token without a cap is never counted', async () => {
    const { issueAccessToken } = await import('../../src/services/access-token-service')
    const { plaintext } = await issueAccessToken({ name: 'operator' })
    const app = buildApp()
    const statuses = await Promise.all(Array.from({ length: 5 }, () => call(app, plaintext)))
    expect(statuses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200])
    expect(await getPrismaClient().accessTokenDailyUsage.count()).toBe(0)
  })
})

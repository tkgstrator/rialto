/**
 * A plan's usage windows at the /v1 gate, and the admin endpoints that
 * read and reset them.
 *
 * The gate is where a limited token is turned away, so what is pinned is
 * what a client sees: a 429 in its own surface's envelope with a
 * Retry-After and the reset instant, catalog reads that do not spend the
 * allowance, and a reset that lets it straight back in.
 */

import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'
import { Hono } from 'hono'
import { accessTokensRoute } from '../../src/api/access-tokens/route'
import { inboundProxyAuth } from '../../src/api/api-key-auth'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { INBOUND_MOUNT_PREFIXES } from '../../src/llms/inbound/surfaces'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { addSpend } from '../../src/services/usage-window-service'
import { HAS_DB, teardownPrisma } from '../db/helpers'

const T0 = Date.parse('2026-09-29T00:00:00.000Z')

function buildGate(): Hono {
  const app = new Hono()
  for (const prefix of INBOUND_MOUNT_PREFIXES) app.use(prefix, inboundProxyAuth)
  const ok = (c: { text: (s: string) => Response }): Response => c.text('ok')
  app.get('/v1/models', ok)
  app.post('/v1/messages/count_tokens', ok)
  app.post('/v1/chat/completions', ok)
  app.post('/v1/messages', ok)
  return app
}

const gate = (path: string, token: string, method = 'POST') =>
  buildGate().fetch(new Request(`http://local${path}`, { method, headers: { authorization: `Bearer ${token}` } }))

const admin = (method: string, path: string) => {
  const app = new OpenAPIHono()
  app.route('/', accessTokensRoute)
  return app.fetch(new Request(`http://local${path}`, { method }))
}

const windowCount = () => getPrismaClient().accessTokenUsageWindow.count()

describe.skipIf(!HAS_DB)('usage windows at the /v1 gate', () => {
  const issued = { id: '', plaintext: '' }

  const issueOnPlan = async (data: {
    fiveHourRequestLimit?: number
    fiveHourSpendLimitUsd?: number
    sevenDayRequestLimit?: number
  }) => {
    const plan = await getPrismaClient().plan.create({
      data: { name: `p-${Math.random()}`, models: ['openai,gpt-x'], defaultModel: 'openai,gpt-x', ...data }
    })
    const token = await issueAccessToken({ name: `t-${Math.random()}`, planId: plan.id })
    return { id: token.token.id, plaintext: token.plaintext }
  }

  beforeEach(async () => {
    setSystemTime(dayjs(T0).toDate())
    await getPrismaClient().$executeRawUnsafe(
      'TRUNCATE "AccessTokenUsageWindow","AccessToken","Plan" RESTART IDENTITY CASCADE'
    )
    invalidateTokenCache()
    Object.assign(issued, await issueOnPlan({ fiveHourRequestLimit: 2 }))
  })

  afterEach(() => {
    setSystemTime()
  })

  afterAll(teardownPrisma)

  test('catalog reads are not counted; completions are, up to the limit', async () => {
    for (const _ of [1, 2, 3]) {
      expect((await gate('/v1/models', issued.plaintext, 'GET')).status).toBe(200)
      expect((await gate('/v1/messages/count_tokens', issued.plaintext)).status).toBe(200)
    }
    expect(await windowCount()).toBe(0)

    expect((await gate('/v1/chat/completions', issued.plaintext)).status).toBe(200)
    expect((await gate('/v1/messages', issued.plaintext)).status).toBe(200)

    const refused = await gate('/v1/chat/completions', issued.plaintext)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe(String(5 * 3600))
    const body = await refused.json()
    expect(body.error.code).toBe('usage_limit_exceeded')
    expect(body.error.type).toBe('rate_limit_error')
    expect(body.error.message).toContain('5-hour request limit')
    expect(body.error.message).toContain('2026-09-29T05:00:00.000Z')

    // Each surface refuses in its own envelope.
    const anthropic = await (await gate('/v1/messages', issued.plaintext)).json()
    expect(anthropic).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } })

    // Still free to read the menu while the window is full.
    expect((await gate('/v1/models', issued.plaintext, 'GET')).status).toBe(200)
  })

  test('a spend limit refuses once the recorded cost reaches it', async () => {
    const spender = await issueOnPlan({ fiveHourSpendLimitUsd: 1 })
    expect((await gate('/v1/chat/completions', spender.plaintext)).status).toBe(200)
    await addSpend(spender.id, 1.5)
    const refused = await gate('/v1/chat/completions', spender.plaintext)
    expect(refused.status).toBe(429)
    expect((await refused.json()).error.message).toContain('5-hour spend limit')
  })

  test('unknown routes and non-POST surface requests do not spend the allowance', async () => {
    expect((await gate('/v1/unknown', issued.plaintext)).status).toBe(404)
    expect((await gate('/v1/chat/completions', issued.plaintext, 'GET')).status).toBe(404)
    expect(await windowCount()).toBe(0)
  })

  test('a token with no plan, or a plan with no limits, is not counted', async () => {
    const free = await issueAccessToken({ name: 'no-plan' })
    const open = await issueOnPlan({})
    for (const token of [free.plaintext, open.plaintext]) {
      expect((await gate('/v1/chat/completions', token)).status).toBe(200)
    }
    expect(await windowCount()).toBe(0)
  })

  test("the admin endpoints read a token's windows and reset them", async () => {
    await gate('/v1/chat/completions', issued.plaintext)
    await gate('/v1/chat/completions', issued.plaintext)
    expect((await gate('/v1/chat/completions', issued.plaintext)).status).toBe(429)

    const read = await admin('GET', `/api/access-tokens/${issued.id}/usage-windows`)
    expect(read.status).toBe(200)
    const usage = await read.json()
    expect(usage.limited).toBe(true)
    expect(usage.windows[0]).toMatchObject({ window: '5h', requests: 2, requestLimit: 2 })

    const reset = await admin('POST', `/api/access-tokens/${issued.id}/usage-windows/reset`)
    expect(reset.status).toBe(200)
    expect((await reset.json()).windows[0]).toMatchObject({ requests: 0, startedAt: null })
    expect((await gate('/v1/chat/completions', issued.plaintext)).status).toBe(200)

    expect((await admin('GET', '/api/access-tokens/nope/usage-windows')).status).toBe(404)
    expect((await admin('POST', '/api/access-tokens/nope/usage-windows/reset')).status).toBe(404)
  })

  test("resetting everyone's windows clears every token", async () => {
    const other = await issueOnPlan({ sevenDayRequestLimit: 1 })
    await gate('/v1/chat/completions', issued.plaintext)
    await gate('/v1/chat/completions', other.plaintext)
    expect((await gate('/v1/chat/completions', other.plaintext)).status).toBe(429)

    const reset = await admin('POST', '/api/access-tokens/usage-windows/reset')
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ cleared: 4 })
    expect(await windowCount()).toBe(0)
    expect((await gate('/v1/chat/completions', other.plaintext)).status).toBe(200)
  })
})

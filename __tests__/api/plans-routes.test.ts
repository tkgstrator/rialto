/**
 * The admin endpoints behind the Plans tab: their status codes and the
 * shapes the UI reads. The gate in front of /api/* is covered
 * elsewhere; these mount the routes bare.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'
import { plansRoute } from '../../src/api/plans/route'
import { getPrismaClient } from '../../src/db/client'
import { HAS_DB, teardownPrisma } from '../db/helpers'

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono()
  app.route('/', plansRoute)
  return app
}

const send = (method: string, path: string, body?: unknown) =>
  buildApp().fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  )

const FREE = {
  name: 'Free',
  models: ['codex,gpt-6-luna', 'google,gemini-3-flash'],
  defaultModel: 'codex,gpt-6-luna',
  fiveHourRequestLimit: 100,
  fiveHourSpendLimitUsd: 2.5,
  sevenDayRequestLimit: null,
  sevenDaySpendLimitUsd: 20
}

describe.skipIf(!HAS_DB)('/api/plans', () => {
  beforeEach(async () => {
    const prisma = getPrismaClient()
    await prisma.accessToken.deleteMany({})
    await prisma.plan.deleteMany({})
  })

  afterAll(teardownPrisma)

  test('creates, lists and edits a plan', async () => {
    const created = await send('POST', '/api/plans', FREE)
    expect(created.status).toBe(200)
    const plan = await created.json()
    expect(plan).toMatchObject({ ...FREE, tokenCount: 0 })

    const listed = await (await send('GET', '/api/plans')).json()
    expect(listed.plans.map((p: { name: string }) => p.name)).toEqual(['Free'])

    const edited = await send('PATCH', `/api/plans/${plan.id}`, {
      sevenDayRequestLimit: 1500,
      fiveHourSpendLimitUsd: null
    })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      fiveHourRequestLimit: 100,
      fiveHourSpendLimitUsd: null,
      sevenDayRequestLimit: 1500,
      sevenDaySpendLimitUsd: 20
    })
  })

  test('answers 400 for a request limit that is not a whole number above zero, or a spend limit not above zero', async () => {
    expect((await send('POST', '/api/plans', { ...FREE, fiveHourRequestLimit: 0 })).status).toBe(400)
    expect((await send('POST', '/api/plans', { ...FREE, sevenDayRequestLimit: 1.5 })).status).toBe(400)
    expect((await send('POST', '/api/plans', { ...FREE, fiveHourSpendLimitUsd: 0 })).status).toBe(400)
    expect((await send('POST', '/api/plans', { ...FREE, sevenDaySpendLimitUsd: -1 })).status).toBe(400)
  })

  test('answers 400 for a default outside the list and 409 for a taken name', async () => {
    expect((await send('POST', '/api/plans', { ...FREE, defaultModel: 'codex,gpt-6-astra' })).status).toBe(400)
    await send('POST', '/api/plans', FREE)
    expect((await send('POST', '/api/plans', FREE)).status).toBe(409)
  })

  test('refuses to delete a plan a token is on, and deletes it once none is', async () => {
    const plan = await (await send('POST', '/api/plans', FREE)).json()
    const token = await getPrismaClient().accessToken.create({
      data: { name: 'laptop', tokenHash: 'a'.repeat(64), prefix: 'rialto_aaaaaa', planId: plan.id }
    })

    // Removing a plan from under its tokens would silently lift their caps.
    expect((await send('DELETE', `/api/plans/${plan.id}`)).status).toBe(409)

    await getPrismaClient().accessToken.delete({ where: { id: token.id } })
    expect((await send('DELETE', `/api/plans/${plan.id}`)).status).toBe(200)
    expect((await send('GET', `/api/plans/${plan.id}`)).status).toBe(404)
  })
})

/**
 * The admin endpoints behind the Plans and Apps tabs: their status codes
 * and the shapes the UI reads. The gate in front of /api/* is covered
 * elsewhere; these mount the routes bare.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authorizedAppsRoute } from '../../src/api/authorized-apps/route'
import { plansRoute } from '../../src/api/plans/route'
import { getPrismaClient } from '../../src/db/client'
import { HAS_DB, teardownPrisma } from '../db/helpers'

function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono()
  app.route('/', plansRoute)
  app.route('/', authorizedAppsRoute)
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
  dailyRequestLimit: 100
}

describe.skipIf(!HAS_DB)('/api/plans and /api/authorized-apps', () => {
  beforeEach(async () => {
    const prisma = getPrismaClient()
    await prisma.appDevice.deleteMany({})
    await prisma.accessToken.deleteMany({})
    await prisma.authorizedApp.deleteMany({})
    await prisma.plan.deleteMany({})
  })

  afterAll(teardownPrisma)

  test('creates, lists and edits a plan', async () => {
    const created = await send('POST', '/api/plans', FREE)
    expect(created.status).toBe(200)
    const plan = await created.json()
    expect(plan).toMatchObject({ ...FREE, tokenCount: 0, apps: [] })

    const listed = await (await send('GET', '/api/plans')).json()
    expect(listed.plans.map((p: { name: string }) => p.name)).toEqual(['Free'])

    const edited = await send('PATCH', `/api/plans/${plan.id}`, { dailyRequestLimit: 150 })
    expect(edited.status).toBe(200)
    expect((await edited.json()).dailyRequestLimit).toBe(150)
  })

  test('answers 400 for a default outside the list and 409 for a taken name', async () => {
    expect((await send('POST', '/api/plans', { ...FREE, defaultModel: 'codex,gpt-6-astra' })).status).toBe(400)
    await send('POST', '/api/plans', FREE)
    expect((await send('POST', '/api/plans', FREE)).status).toBe(409)
  })

  test('authorizes an app, edits it, and switches it off and on', async () => {
    const plan = await (await send('POST', '/api/plans', FREE)).json()
    const created = await send('POST', '/api/authorized-apps', {
      name: 'Connect',
      appleAppId: '5Q94QJ7G98.jp.qleap.connect',
      planId: plan.id,
      allowDevelopment: false
    })
    expect(created.status).toBe(200)
    const app = await created.json()
    expect(app).toMatchObject({ enabled: true, plan: { name: 'Free' }, deviceCount: 0, requestsToday: 0 })

    const saved = await send('PATCH', `/api/authorized-apps/${app.id}`, {
      name: 'Connect (iOS)',
      planId: plan.id,
      allowDevelopment: true
    })
    expect(await saved.json()).toMatchObject({ name: 'Connect (iOS)', allowDevelopment: true, enabled: true })

    expect((await (await send('POST', `/api/authorized-apps/${app.id}/disable`)).json()).enabled).toBe(false)
    expect((await (await send('POST', `/api/authorized-apps/${app.id}/enable`)).json()).enabled).toBe(true)

    // A plan an app starts installs on cannot be deleted out from under it.
    expect((await send('DELETE', `/api/plans/${plan.id}`)).status).toBe(409)

    const devices = await (await send('GET', `/api/authorized-apps/${app.id}/devices?limit=10`)).json()
    expect(devices).toEqual({ total: 0, devices: [] })
  })

  test('refuses a malformed App ID and a duplicate one', async () => {
    const plan = await (await send('POST', '/api/plans', FREE)).json()
    const body = { name: 'X', appleAppId: 'jp.qleap.connect', planId: plan.id, allowDevelopment: false }
    expect((await send('POST', '/api/authorized-apps', body)).status).toBe(400)
    const good = { ...body, appleAppId: '5Q94QJ7G98.jp.qleap.connect' }
    expect((await send('POST', '/api/authorized-apps', good)).status).toBe(200)
    expect((await send('POST', '/api/authorized-apps', good)).status).toBe(409)
  })
})

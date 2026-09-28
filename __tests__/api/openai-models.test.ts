/**
 * GET /v1/models — OpenAI-compat catalog surface.
 *
 * Verifies the endpoint returns the DB-backed enabled model list in
 * OpenAI's `{object:'list', data:[{id, object, created, owned_by}]}`
 * shape, with `id` set to Rialto's canonical `provider,model` string so
 * OpenAI SDK clients can round-trip the id straight back into
 * /v1/chat/completions' `model` field.
 *
 * DB-backed: gated on HAS_DB the same way the config-service round-trip
 * tests are, so `bun test` skips cleanly when no test DB is wired up.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import '../../src/api/context'
import { v1ModelsRoute } from '../../src/api/v1/models-list'
import { getPrismaClient } from '../../src/db/client'
import { applyUiConfig, ensurePreferenceProfile } from '../../src/services/config'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

describe.skipIf(!HAS_DB)('GET /v1/models', () => {
  beforeEach(async () => {
    await resetDbTables()
    await ensurePreferenceProfile()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  const call = async (): Promise<Response> => v1ModelsRoute.fetch(new Request('http://local/v1/models'))

  test('returns an empty list envelope when no models are enabled', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: unknown[] }
    expect(body.object).toBe('list')
    expect(body.data).toEqual([])
  })

  test('lists enabled models in `provider,model` id form', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-test',
          auth_mode: 'api_key',
          models: ['gpt-5-mini', 'gpt-4.1']
        }
      ]
    })
    // applyUiConfig only inserts models with enabled=false by default —
    // flip them on so getEnabledModels returns something.
    const prisma = getPrismaClient()
    await prisma.model.updateMany({ data: { enabled: true } })

    const res = await call()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      data: Array<{ id: string; object: string; created: number; owned_by: string }>
    }
    expect(body.object).toBe('list')
    const ids = body.data.map((m) => m.id).sort()
    expect(ids).toEqual(['openai,gpt-4.1', 'openai,gpt-5-mini'])
    for (const item of body.data) {
      expect(item.object).toBe('model')
      expect(item.owned_by).toBe('openai')
      expect(typeof item.created).toBe('number')
    }
  })

  test('a token on a plan sees only the plan’s models', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-test',
          auth_mode: 'api_key',
          models: ['gpt-5-mini', 'gpt-4.1']
        }
      ]
    })
    await getPrismaClient().model.updateMany({ data: { enabled: true } })

    // Stand in for the /v1 gate, which sets the resolved token.
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('accessToken', {
        id: 'tok',
        name: 'app',
        surfaces: [],
        profileKey: null,
        plan: { models: ['openai,gpt-5-mini'], defaultModel: 'openai,gpt-5-mini', dailyRequestLimit: 100 }
      })
      await next()
    })
    app.route('/', v1ModelsRoute)
    const res = await app.fetch(new Request('http://local/v1/models'))
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((m) => m.id)).toEqual(['openai,gpt-5-mini'])
  })

  test('hides models on providers with no api_key (unroutable)', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-test',
          auth_mode: 'api_key',
          models: ['gpt-5-mini']
        },
        {
          name: 'anthropic',
          api_base_url: 'https://api.anthropic.com/v1/messages',
          api_key: '',
          auth_mode: 'api_key',
          models: ['claude-haiku']
        }
      ]
    })
    const prisma = getPrismaClient()
    await prisma.model.updateMany({ data: { enabled: true } })

    const res = await call()
    const body = (await res.json()) as { data: Array<{ id: string }> }
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain('openai,gpt-5-mini')
    // anthropic has no key — its models must not be advertised as routable.
    expect(ids).not.toContain('anthropic,claude-haiku')
  })

  test('carries the bare name, context window and price per million tokens', async () => {
    await applyUiConfig({
      Providers: [
        {
          name: 'openai',
          api_base_url: 'https://api.openai.com/v1/chat/completions',
          api_key: 'sk-test',
          auth_mode: 'api_key',
          models: ['gpt-5-mini', 'gpt-4.1']
        }
      ]
    })
    const prisma = getPrismaClient()
    await prisma.model.updateMany({ data: { enabled: true } })
    await prisma.model.updateMany({
      where: { name: 'gpt-5-mini' },
      data: { inputPer1M: 0.25, outputPer1M: 2, cachedInputPer1M: 0.025, contextWindow: 400_000 }
    })
    // Only half a price: published as none, never as a cheap one.
    await prisma.model.updateMany({ where: { name: 'gpt-4.1' }, data: { inputPer1M: 2 } })

    const parsed = z
      .object({ data: z.array(z.object({ id: z.string().nonempty() }).passthrough()) })
      .safeParse(await (await call()).json())
    if (!parsed.success) throw parsed.error
    const byId = new Map(parsed.data.data.map((m) => [m.id, m]))
    expect(byId.get('openai,gpt-5-mini')).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      context_window: 400_000,
      pricing: {
        unit: 'usd_per_1m_tokens',
        input: 0.25,
        output: 2,
        cached_input: 0.025,
        cache_write_5m: 0.3125,
        cache_write_1h: 0.5
      }
    })
    expect(byId.get('openai,gpt-4.1')).toMatchObject({ context_window: null, pricing: null })
  })
})

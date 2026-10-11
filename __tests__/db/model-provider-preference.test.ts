import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAPIHono } from '@hono/zod-openapi'
import { modelProviderPrioritiesRoute } from '../../src/api/models/provider-priorities/route'
import { getPrismaClient } from '../../src/db/client'
import {
  listModelProviderPriorities,
  resolvePreferredProvider,
  setModelProviderPriorities
} from '../../src/services/model-provider-preference'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

const app = new OpenAPIHono()
app.route('/', modelProviderPrioritiesRoute)

const request = (method: 'GET' | 'PUT', body?: unknown) =>
  app.fetch(
    new Request('http://local/api/models/provider-priorities', {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
  )

async function addProvider(name: string, models: string[]): Promise<void> {
  await getPrismaClient().provider.create({
    data: { name, apiBaseUrl: `https://${name}.example`, models: { create: models.map((model) => ({ name: model })) } }
  })
}

describe.skipIf(!HAS_DB)('global bare model provider preferences', () => {
  beforeEach(async () => {
    await resetDbTables()
    await addProvider('alpha', ['same', 'only-alpha'])
    await addProvider('beta', ['same', 'only-beta'])
    await addProvider('gamma', ['same'])
  })
  afterAll(teardownPrisma)

  test('without a preference duplicates remain ambiguous; one eligible provider resolves', async () => {
    expect(await resolvePreferredProvider('same', ['alpha', 'beta'])).toEqual({ status: 'ambiguous' })
    expect(await resolvePreferredProvider('same', ['alpha'])).toEqual({ status: 'preferred', provider: 'alpha' })
    expect(await resolvePreferredProvider('same', ['alpha'], ['beta'])).toEqual({ status: 'unavailable' })
    expect(await listModelProviderPriorities()).toEqual([
      { model: 'same', providers: ['alpha', 'beta', 'gamma'], preferredProviders: [] }
    ])
  })

  test('preserves configured order and restricts selection to eligible and plan-allowed targets', async () => {
    expect(await setModelProviderPriorities('same', ['gamma', 'beta', 'alpha'])).toEqual({ ok: true })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta', 'gamma'])).toEqual({
      status: 'preferred',
      provider: 'gamma'
    })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta', 'gamma'], ['alpha', 'beta'])).toEqual({
      status: 'preferred',
      provider: 'beta'
    })
    expect(await request('GET').then((response) => response.json())).toEqual({
      models: [{ model: 'same', providers: ['gamma', 'beta', 'alpha'], preferredProviders: ['gamma', 'beta', 'alpha'] }]
    })
    expect(await setModelProviderPriorities('same', ['alpha', 'gamma'])).toEqual({ ok: true })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta'])).toEqual({
      status: 'preferred',
      provider: 'alpha'
    })
    expect(await resolvePreferredProvider('same', ['beta', 'gamma'])).toEqual({
      status: 'preferred',
      provider: 'gamma'
    })
    expect(await resolvePreferredProvider('same', ['beta', 'alpha'], ['beta'])).toEqual({
      status: 'preferred',
      provider: 'beta'
    })
    expect(await setModelProviderPriorities('same', [])).toEqual({ ok: true })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta'])).toEqual({ status: 'ambiguous' })
  })

  test('PUT rejects unknown model, unrelated or repeated provider, without changing the old preference', async () => {
    expect((await request('PUT', { model: 'same', providers: ['beta', 'alpha'] })).status).toBe(200)
    expect((await request('PUT', { model: 'missing', providers: ['alpha'] })).status).toBe(404)
    expect((await request('PUT', { model: 'only-alpha', providers: ['beta'] })).status).toBe(404)
    expect((await request('PUT', { model: 'same', providers: ['unknown'] })).status).toBe(404)
    expect((await request('PUT', { model: 'same', providers: ['alpha', 'alpha'] })).status).toBe(400)
    expect((await request('PUT', { model: 'same', providers: ['alpha', 'beta', ''] })).status).toBe(400)
    expect(await resolvePreferredProvider('same', ['alpha', 'beta'])).toEqual({ status: 'preferred', provider: 'beta' })
  })

  test('deleting a model cascades its preference and does not leave a stale provider choice', async () => {
    await setModelProviderPriorities('same', ['alpha', 'beta'])
    await getPrismaClient().model.delete({
      where: {
        providerId_name: {
          providerId: (await getPrismaClient().provider.findUniqueOrThrow({ where: { name: 'alpha' } })).id,
          name: 'same'
        }
      }
    })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta', 'gamma'])).toEqual({
      status: 'preferred',
      provider: 'beta'
    })
    expect(await listModelProviderPriorities()).toEqual([
      { model: 'same', providers: ['beta', 'gamma'], preferredProviders: ['beta'] }
    ])
  })
})

/**
 * A Custom provider end to end through the services: created from a typed
 * Base URL, its model list looked up once or typed by hand, its wire format
 * kept across later saves, and reconciled on Refresh.
 *
 * Nothing here reaches the network. The creation path takes the fetch it
 * should use; the jobs under test are run with the global fetch replaced by
 * one that records any call, so "skips custom providers cleanly" is checked
 * as "asks nobody anything" and not only as "returned no error".
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { refreshModelsRoute } from '../../src/api/refresh-models/route'
import { getPrismaClient } from '../../src/db/client'
import { ApiStyle } from '../../src/generated/prisma/client'
import { getLlmsContext, resetLlmsContext } from '../../src/llms'
import { upsertProvider } from '../../src/services/config'
import { createCustomProvider } from '../../src/services/custom-provider-service'
import { refreshModelsForAllProviders } from '../../src/services/model-sync-service'
import { testProvider } from '../../src/services/provider-test-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

type Input = Parameters<typeof createCustomProvider>[0]

const input = (over: Partial<Input> = {}): Input => ({
  name: 'lm-studio',
  base_url: 'http://localhost:1234',
  api_key: 'lm-studio',
  api_style: 'openai_chat',
  ...over
})

const listing =
  (...ids: string[]): typeof fetch =>
  async () =>
    Response.json({ data: ids.map((id) => ({ id })) })

const down: typeof fetch = async () => new Response('nope', { status: 503 })

const rowsOf = async (name: string) =>
  getPrismaClient().model.findMany({ where: { provider: { name } }, orderBy: { name: 'asc' } })

// Record catalog requests without reaching the network.
type Request = { url: string; headers: Headers }
const requests: Request[] = []
const stubs: Array<{ mockRestore: () => void }> = []
const stubFetch = (answer: () => Response): void => {
  stubs.push(
    spyOn(globalThis, 'fetch').mockImplementation(async (target, init) => {
      requests.push({ url: String(target), headers: new Headers(init?.headers) })
      return answer()
    })
  )
}
const restoreFetch = (): void => {
  for (const stub of stubs.splice(0)) stub.mockRestore()
}

describe.skipIf(!HAS_DB)('createCustomProvider', () => {
  beforeEach(async () => {
    await resetDbTables()
    resetLlmsContext()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('stores the derived endpoint, api_key auth and the chosen format, switched off', async () => {
    const result = await createCustomProvider(
      input({ base_url: 'http://localhost:1234/v1', api_style: 'openai_responses' }),
      listing('qwen3', 'llama-4')
    )
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
    expect(result.provider.api_base_url).toBe('http://localhost:1234/v1/responses')
    expect(result.provider.auth_mode).toBe('api_key')
    expect(result.provider.api_style).toBe('openai_responses')
    expect(result.provider.enabled).toBe(false)

    const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name: 'lm-studio' } })
    expect(row.apiBaseUrl).toBe('http://localhost:1234/v1/responses')
    expect(row.apiKey).toBe('lm-studio')
    expect(row.apiStyle).toBe(ApiStyle.openai_responses)
    expect(row.enabled).toBe(false)
  })

  test('maps each of the three formats onto its api_style and its tail', async () => {
    const cases = [
      ['anthropic', ApiStyle.anthropic, 'http://h:1/v1/messages'],
      ['openai_chat', ApiStyle.openai_chat, 'http://h:1/v1/chat/completions'],
      ['openai_responses', ApiStyle.openai_responses, 'http://h:1/v1/responses']
    ] as const
    for (const [index, [style, stored, endpoint]] of cases.entries()) {
      const result = await createCustomProvider(
        input({ name: `gw-${index}`, base_url: 'http://h:1', api_style: style }),
        down
      )
      expect(result.ok).toBe(true)
      const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name: `gw-${index}` } })
      expect(row.apiStyle).toBe(stored)
      expect(row.apiBaseUrl).toBe(endpoint)
    }
  })

  test('a found list becomes model rows, all off, with no price and no context window', async () => {
    const result = await createCustomProvider(input(), listing('qwen3', 'gpt-4o', 'gpt-5-codex'))
    if (!result.ok) throw new Error('expected ok')
    expect(result.models).toEqual({ status: 'found', count: 3 })

    const rows = await rowsOf('lm-studio')
    expect(rows.map((r) => r.name)).toEqual(['gpt-4o', 'gpt-5-codex', 'qwen3'])
    for (const row of rows) {
      expect(row.enabled).toBe(false)
      expect(row.inputPer1M).toBeNull()
      expect(row.outputPer1M).toBeNull()
      expect(row.cachedInputPer1M).toBeNull()
      expect(row.contextWindow).toBeNull()
    }
  })

  test('a model named like a codex one is not Responses-only here: it inherits the provider style', async () => {
    await createCustomProvider(input(), listing('gpt-5-codex'))
    const [row] = await rowsOf('lm-studio')
    expect(row.apiStyle).toBeNull()
  })

  test('the lookup going wrong still creates the provider, with the reason and no models', async () => {
    const result = await createCustomProvider(input(), down)
    if (!result.ok) throw new Error('expected ok')
    expect(result.models.status).toBe('unavailable')
    expect(result.models.status === 'unavailable' && result.models.error).toContain('HTTP 503')
    expect(await rowsOf('lm-studio')).toEqual([])
    expect(await getPrismaClient().provider.count({ where: { name: 'lm-studio' } })).toBe(1)
  })

  test('a name that is taken is refused, whatever its case, and the endpoint is never asked', async () => {
    await createCustomProvider(input({ name: 'my-gateway' }), down)
    const asked: string[] = []
    const spy: typeof fetch = async (target) => {
      asked.push(String(target))
      return Response.json({ data: [] })
    }
    expect(await createCustomProvider(input({ name: 'my-gateway' }), spy)).toEqual({
      ok: false,
      reason: 'name_taken'
    })
    expect(await createCustomProvider(input({ name: 'MY-Gateway' }), spy)).toEqual({
      ok: false,
      reason: 'name_taken'
    })
    expect(asked).toEqual([])
    expect(await getPrismaClient().provider.count()).toBe(1)
  })

  test('a name that a built-in vendor row holds is taken too', async () => {
    await upsertProvider({
      name: 'openai',
      enabled: true,
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk',
      auth_mode: 'api_key',
      models: []
    })
    expect((await createCustomProvider(input({ name: 'openai' }), down)).ok).toBe(false)
  })

  test('a Base URL that is not an http(s) address is refused before anything is stored', async () => {
    expect(await createCustomProvider(input({ base_url: 'ftp://h/v1' }), down)).toEqual({
      ok: false,
      reason: 'invalid_base_url'
    })
    expect(await getPrismaClient().provider.count()).toBe(0)
  })
})

describe.skipIf(!HAS_DB)('a custom provider after it exists', () => {
  beforeEach(async () => {
    await resetDbTables()
    resetLlmsContext()
    requests.length = 0
  })

  afterEach(restoreFetch)

  afterAll(async () => {
    await teardownPrisma()
  })

  // What the provider screen sends back: the stored provider, edited.
  const save = async (name: string, models: string[], extra: Record<string, unknown> = {}) => {
    const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name } })
    return upsertProvider({
      name,
      enabled: row.enabled,
      api_base_url: row.apiBaseUrl,
      api_key: row.apiKey,
      auth_mode: 'api_key',
      models,
      ...extra
    })
  }

  test('its format survives a save that does not mention it', async () => {
    await createCustomProvider(input({ api_style: 'anthropic' }), listing('claude-x'))
    await save('lm-studio', ['claude-x'], { api_key: 'rotated' })
    const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name: 'lm-studio' } })
    expect(row.apiStyle).toBe(ApiStyle.anthropic)
    expect(row.apiKey).toBe('rotated')
  })

  test('the operator can move it to another of the three formats', async () => {
    await createCustomProvider(input({ api_style: 'openai_chat' }), down)
    await save('lm-studio', [], { api_style: 'openai_responses' })
    const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name: 'lm-studio' } })
    expect(row.apiStyle).toBe(ApiStyle.openai_responses)
  })

  test('gemini cannot be stored on it', async () => {
    await createCustomProvider(input({ api_style: 'anthropic' }), down)
    await save('lm-studio', [], { api_style: 'gemini' })
    const row = await getPrismaClient().provider.findFirstOrThrow({ where: { name: 'lm-studio' } })
    expect(row.apiStyle).toBe(ApiStyle.anthropic)
  })

  test('a model added by hand lands switched on while the looked-up ones stay off', async () => {
    await createCustomProvider(input(), listing('qwen3'))
    // What the models step sends: the full list, the new id left out of the
    // disabled set.
    await save('lm-studio', ['qwen3', 'my-finetune'], { transformer: { _disabledModels: ['qwen3'] } })
    const rows = await rowsOf('lm-studio')
    expect(Object.fromEntries(rows.map((r) => [r.name, r.enabled]))).toEqual({ 'my-finetune': true, qwen3: false })
    expect(rows.every((r) => r.inputPer1M === null && r.contextWindow === null)).toBe(true)
  })

  test('a manual model works when the lookup found nothing at all', async () => {
    await createCustomProvider(input(), down)
    await save('lm-studio', ['my-finetune'])
    expect((await rowsOf('lm-studio')).map((r) => r.name)).toEqual(['my-finetune'])
  })

  test('once switched on it is registered with the chain its format implies', async () => {
    const chains = [
      ['anthropic', ['anthropic']],
      ['openai_chat', ['openai']],
      ['openai_responses', ['openai-responses']]
    ] as const
    for (const [index, [style, chain]] of chains.entries()) {
      const name = `gw-${index}`
      await createCustomProvider(input({ name, api_style: style }), listing('m1'))
      await save(name, ['m1'], { enabled: true, transformer: { _disabledModels: [] } })
      const ctx = await getLlmsContext()
      expect(ctx.providers.get(name)?.transformer?.use?.map((t) => t.name)).toEqual([...chain])
    }
  })

  test('scoped refresh reconciles the full listing and retains settings for surviving models', async () => {
    await createCustomProvider(
      input({ base_url: 'http://localhost:1234/team/v1', api_style: 'anthropic' }),
      listing('kept', 'removed')
    )
    await save('lm-studio', ['kept', 'removed'], { enabled: true, transformer: { _disabledModels: [] } })
    await createCustomProvider(input({ name: 'other' }), listing('untouched'))
    const [kept] = await rowsOf('lm-studio')
    const pages = [
      { data: [{ id: 'kept', max_input_tokens: 32768 }], has_more: true, last_id: 'kept' },
      { data: [{ id: 'added' }], has_more: false }
    ]
    stubFetch(() => Response.json(pages.shift()))

    const response = await refreshModelsRoute.request('/api/refresh-models?provider=lm-studio', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcomes: [{ provider: 'lm-studio', added: ['added'] }] })
    const rows = await rowsOf('lm-studio')
    expect(rows.map(({ name, enabled, contextWindow }) => ({ name, enabled, contextWindow }))).toEqual([
      { name: 'added', enabled: false, contextWindow: null },
      { name: 'kept', enabled: true, contextWindow: 32768 }
    ])
    expect(rows[1].id).toBe(kept.id)
    expect((await rowsOf('other')).map(({ name }) => name)).toEqual(['untouched'])
    expect(requests.map(({ url }) => url)).toEqual([
      'http://localhost:1234/team/v1/models',
      'http://localhost:1234/team/v1/models?after_id=kept'
    ])
    expect(requests[0].headers.get('x-api-key')).toBe('lm-studio')
  })

  test('a failed or malformed listing leaves the stored models intact', async () => {
    await createCustomProvider(input(), listing('qwen3', 'gpt-4o'))
    const before = await rowsOf('lm-studio')
    stubFetch(() => Response.json({ data: [{}] }))
    expect((await refreshModelsForAllProviders())[0].error).toContain('unrecognised response shape')
    expect(await rowsOf('lm-studio')).toEqual(before)
    restoreFetch()
    stubFetch(() => new Response('unavailable', { status: 503 }))
    expect((await refreshModelsForAllProviders())[0].error).toContain('HTTP 503')
    expect(await rowsOf('lm-studio')).toEqual(before)
  })

  test('a successful empty listing removes all custom models', async () => {
    await createCustomProvider(input(), listing('qwen3'))
    stubFetch(() => Response.json({ data: [] }))
    expect(await refreshModelsForAllProviders()).toEqual([{ provider: 'lm-studio', added: [] }])
    expect(await rowsOf('lm-studio')).toEqual([])
  })

  test('the committed price list is not applied to it, so its prices stay unknown', async () => {
    // `gpt-4o` is in the committed price table under OpenAI.
    await createCustomProvider(input(), listing('gpt-4o', 'qwen3'))
    stubFetch(() => new Response('', { status: 503 }))
    await refreshModelsForAllProviders()
    const rows = await rowsOf('lm-studio')
    expect(rows.map((r) => [r.name, r.inputPer1M, r.outputPer1M])).toEqual([
      ['gpt-4o', null, null],
      ['qwen3', null, null]
    ])
  })

  test('a catalog vendor beside it is still priced from that list, without pricing custom models', async () => {
    await createCustomProvider(input(), listing('gpt-4o'))
    await upsertProvider({
      name: 'openai',
      enabled: true,
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-test',
      auth_mode: 'api_key',
      models: ['gpt-4o']
    })
    stubFetch(() => new Response('', { status: 503 }))

    const outcomes = await refreshModelsForAllProviders()

    expect(outcomes.find((o) => o.provider === 'lm-studio')?.error).toContain('HTTP 503')
    expect(outcomes.find((o) => o.provider === 'openai')?.skipped).toBeUndefined()
    const [custom] = await rowsOf('lm-studio')
    const [catalog] = await rowsOf('openai')
    expect(custom.inputPer1M).toBeNull()
    expect(catalog.inputPer1M).not.toBeNull()
    expect(requests.some((r) => r.url === 'http://localhost:1234/v1/models')).toBe(true)
  })

  test('the provider test is the models lookup: reachable with a good key passes', async () => {
    await createCustomProvider(input(), listing('qwen3'))
    await save('lm-studio', ['qwen3'], { enabled: true })
    stubFetch(() => Response.json({ data: [{ id: 'qwen3' }] }))

    const result = await testProvider('lm-studio')

    expect(result.success).toBe(true)
    expect(requests[0].url).toBe('http://localhost:1234/v1/models')
    expect(requests[0].headers.get('authorization')).toBe('Bearer lm-studio')
  })

  test('the provider test fails with the endpoint reason when the key is refused', async () => {
    await createCustomProvider(input(), down)
    await save('lm-studio', [], { enabled: true })
    stubFetch(() => new Response('denied', { status: 401 }))

    const result = await testProvider('lm-studio')

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 401')
  })

  test('the provider test of an Anthropic-format provider sends x-api-key, not a Bearer token', async () => {
    await createCustomProvider(input({ api_style: 'anthropic' }), down)
    await save('lm-studio', [], { enabled: true })
    stubFetch(() => Response.json({ data: [{ id: 'claude-x' }] }))

    expect((await testProvider('lm-studio')).success).toBe(true)
    expect(requests[0].headers.get('x-api-key')).toBe('lm-studio')
    expect(requests[0].headers.get('authorization')).toBeNull()
  })
})

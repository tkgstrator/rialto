import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectApiKeys, loadSubscriptionMatrix, restoreApiKeys } from '../../scripts/capture-fixtures/config'
import { capture, hashKey, redactResponseBody, sanitizeSlug } from '../../scripts/capture-fixtures/record'
import { buildScenarioSpecs } from '../../scripts/capture-fixtures/scenarios'
import { buildSmokeSpecs, buildSubscriptionSpecs } from '../../scripts/capture-fixtures/smokes'
import type { RequestSpec } from '../../scripts/capture-fixtures/types'
import { hashRequest } from '../providers/fixtures'

const base = 'http://127.0.0.1:16173'
const messagesUrl = `${base}/v1/messages`
const connection = { configUrl: `${base}/api/config`, apiKey: 'test' }

// This digest was computed from the pre-split script, including every
// label, slug, URL and body in order. Cache prefix text is byte-sensitive.
test('the complete request matrix remains byte-for-byte compatible', () => {
  const specs: RequestSpec[] = [
    { label: 'GET /api/config', slug: 'api-config', method: 'GET', url: connection.configUrl },
    ...buildSmokeSpecs(messagesUrl),
    ...buildSubscriptionSpecs(messagesUrl, [
      { name: 'claude-code', models: ['claude-haiku-4-5'] },
      { name: 'codex', models: ['gpt-5.5'] }
    ]),
    ...buildScenarioSpecs(messagesUrl)
  ]
  expect(specs).toHaveLength(34)
  expect(createHash('sha256').update(JSON.stringify(specs)).digest('hex')).toBe(
    'd111dd5cfa88c38907d36eebecd3d2782308cc89b80cb7b38f84a68ebd879dac'
  )
  for (const spec of specs)
    expect(hashKey(spec.method, spec.url, spec.body)).toBe(hashRequest(spec.method, spec.url, spec.body))
})

test('missing and null bodies have the same replay hash', () => {
  expect(hashKey('GET', connection.configUrl, undefined)).toBe(hashKey('GET', connection.configUrl, null))
  expect(sanitizeSlug(' /openai//gpt-5.5: hello ')).toBe('openai-gpt-5.5-hello')
})

test('only config credentials are redacted, leaving other response data intact', () => {
  const body = JSON.stringify({
    APIKEY: 'server-secret',
    Providers: [
      { name: 'openai', api_key: 'provider-secret', models: ['gpt-5.5'] },
      { name: 'unset', api_key: null }
    ]
  })
  expect(JSON.parse(redactResponseBody(connection.configUrl, body))).toEqual({
    APIKEY: '***REDACTED***',
    Providers: [
      { name: 'openai', api_key: '***REDACTED***', models: ['gpt-5.5'] },
      { name: 'unset', api_key: null }
    ]
  })
  expect(redactResponseBody(messagesUrl, body)).toBe(body)
  expect(redactResponseBody(connection.configUrl, 'not-json')).toBe('not-json')
})

describe('capture with local responses only', () => {
  const state = { fetch: globalThis.fetch, dir: '' }
  const spec: RequestSpec = {
    label: 'hello',
    slug: 'test/hello',
    method: 'POST',
    url: messagesUrl,
    body: { stream: true }
  }
  beforeEach(() => {
    state.fetch = globalThis.fetch
    state.dir = mkdtempSync(join(tmpdir(), 'rialto-capture-test-'))
  })
  afterEach(() => {
    globalThis.fetch = state.fetch
    rmSync(state.dir, { recursive: true, force: true })
  })

  test('records the three replay files, skips complete fixtures, and supports force', async () => {
    const calls: RequestInit[] = []
    globalThis.fetch = async (_url, init) => {
      if (init !== undefined) calls.push(init)
      return new Response('data: hello\n\n', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    const options = { fixturesDir: state.dir, apiKey: 'test', force: false }
    expect(await capture(spec, options)).toBe('recorded')
    expect(await capture(spec, options)).toBe('skipped')
    expect(calls).toHaveLength(1)
    expect(calls[0].headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'test',
      'anthropic-version': '2023-06-01',
      'Accept-Encoding': 'identity'
    })
    const dir = join(state.dir, `test-hello.${hashKey(spec.method, spec.url, spec.body)}`)
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))).toEqual({
      label: spec.label,
      method: spec.method,
      url: spec.url,
      body: spec.body
    })
    expect(JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8'))).toEqual({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' }
    })
    expect(readFileSync(join(dir, 'response.body'), 'utf8')).toBe('data: hello\n\n')
    expect(await capture(spec, { ...options, force: true })).toBe('recorded')
    expect(calls).toHaveLength(2)
  })

  test('records HTTP errors but reports transport failures', async () => {
    globalThis.fetch = async () => new Response('upstream refused', { status: 429 })
    const options = { fixturesDir: state.dir, apiKey: 'test', force: true }
    expect(await capture(spec, options)).toBe('recorded')
    globalThis.fetch = async () => {
      throw new Error('offline')
    }
    expect(await capture(spec, options)).toBe('failed')
  })
})

describe('capture config round trips', () => {
  const keys = ['NO_INJECT', 'OPENAI_API_KEY', 'GEMINI_API_KEY']
  const state = { fetch: globalThis.fetch, env: new Map<string, string | undefined>() }
  beforeEach(() => {
    state.fetch = globalThis.fetch
    state.env = new Map(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
  })
  afterEach(() => {
    globalThis.fetch = state.fetch
    for (const [key, value] of state.env) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('only enabled subscription models enter the smoke matrix', async () => {
    globalThis.fetch = async () =>
      Response.json({
        Providers: [
          {
            name: 'claude-code',
            auth_mode: 'subscription',
            models: ['on', 'off'],
            transformer: { _disabledModels: ['off'] }
          },
          { name: 'codex', auth_mode: 'subscription' },
          { name: 'openai', auth_mode: 'api_key', models: ['gpt-5.5'] }
        ]
      })
    expect(await loadSubscriptionMatrix(connection)).toEqual([
      { name: 'claude-code', models: ['on'] },
      { name: 'codex', models: [] }
    ])
  })

  test('injection and restoration preserve the complete provider list and settings', async () => {
    const providers = [
      { name: 'openai', api_key: null, models: ['gpt-5.5'], transformer: { use: ['openai'] } },
      { name: 'google', api_key: 'prior-key', models: ['gemini-2.5-flash'] },
      { name: 'claude-code', api_key: null, auth_mode: 'subscription', models: ['claude-haiku-4-5'] }
    ]
    const writes: unknown[] = []
    const config = { providers }
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        const update = JSON.parse(String(init.body))
        writes.push(update)
        config.providers = update.Providers
      }
      return Response.json({ Providers: config.providers })
    }
    process.env.OPENAI_API_KEY = 'injected-openai'
    process.env.GEMINI_API_KEY = 'injected-google'
    const injection = await injectApiKeys(connection)
    expect(injection).toEqual({ prior: { openai: null, google: 'prior-key' } })
    expect(writes[0]).toEqual({
      Providers: [
        { ...providers[0], api_key: 'injected-openai' },
        { ...providers[1], api_key: 'injected-google' },
        providers[2]
      ]
    })
    if (injection === null) throw new Error('expected injected keys')
    await restoreApiKeys(connection, injection)
    expect(writes[1]).toEqual({ Providers: providers })
  })

  test('NO_INJECT never reads or updates config', async () => {
    process.env.NO_INJECT = '1'
    globalThis.fetch = async () => {
      throw new Error('must not fetch')
    }
    expect(await injectApiKeys(connection)).toBeNull()
  })

  test('missing keys perform no provider update', async () => {
    const calls: string[] = []
    globalThis.fetch = async (_url, init) => {
      calls.push(init?.method === undefined ? 'GET' : init.method)
      return Response.json({ Providers: [] })
    }
    expect(await injectApiKeys(connection)).toBeNull()
    expect(calls).toEqual(['GET'])
  })
})

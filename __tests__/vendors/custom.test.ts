/**
 * The one-shot model lookup a Custom provider runs at connect time.
 *
 * It has to be a result and never an exception: a server with no `/models`,
 * a wrong key or a timeout all end in "type the model ids by hand", so every
 * failure below is asserted as `{ ok: false }` with the reason the operator
 * is shown, and the success cases pin what is sent and where.
 */
import { describe, expect, test } from 'bun:test'
import { fetchCustomModels } from '../../src/vendors/custom'

type Seen = { url: string; headers: Headers; redirect: RequestRedirect | undefined }

// A fake fetch that answers per URL and records what it was asked.
const serve = (answers: Record<string, () => Response | Promise<Response>>) => {
  const seen: Seen[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    seen.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect })
    const answer = answers[url]
    return answer === undefined ? new Response('not found', { status: 404 }) : answer()
  }
  return { fetchImpl, seen }
}

const openaiList = (...ids: string[]) => Response.json({ object: 'list', data: ids.map((id) => ({ id })) })

describe('fetchCustomModels - what is asked', () => {
  test('an OpenAI-style endpoint is asked at /v1/models with a Bearer key', async () => {
    const { fetchImpl, seen } = serve({ 'http://localhost:1234/v1/models': () => openaiList('qwen3', 'llama-4') })
    const result = await fetchCustomModels(
      { baseUrl: 'http://localhost:1234', apiKey: 'lm-studio', style: 'openai_chat' },
      fetchImpl
    )
    expect(result).toEqual({ ok: true, ids: ['qwen3', 'llama-4'] })
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.get('authorization')).toBe('Bearer lm-studio')
    expect(seen[0].headers.get('x-api-key')).toBeNull()
  })

  test('a base that already ends in /v1 is not asked at /v1/v1/models', async () => {
    const { fetchImpl, seen } = serve({ 'http://localhost:1234/v1/models': () => openaiList('m') })
    const result = await fetchCustomModels(
      { baseUrl: 'http://localhost:1234/v1', apiKey: 'k', style: 'openai_responses' },
      fetchImpl
    )
    expect(result.ok).toBe(true)
    expect(seen.map((s) => s.url)).toEqual(['http://localhost:1234/v1/models'])
  })

  test('an Anthropic-style endpoint sends x-api-key and anthropic-version, not a Bearer token', async () => {
    const { fetchImpl, seen } = serve({
      'https://gw.example.com/v1/models': () => Response.json({ data: [{ id: 'claude-sonnet-5' }] })
    })
    const result = await fetchCustomModels(
      { baseUrl: 'https://gw.example.com', apiKey: 'sk-ant-xyz', style: 'anthropic' },
      fetchImpl
    )
    expect(result).toEqual({ ok: true, ids: ['claude-sonnet-5'] })
    expect(seen[0].headers.get('x-api-key')).toBe('sk-ant-xyz')
    expect(seen[0].headers.get('anthropic-version')).toBe('2023-06-01')
    expect(seen[0].headers.get('authorization')).toBeNull()
  })

  test('a typed endpoint tail is stripped before the list is looked for', async () => {
    const { fetchImpl, seen } = serve({ 'http://h:1/v1/models': () => openaiList('m') })
    await fetchCustomModels({ baseUrl: 'http://h:1/v1/chat/completions', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(seen[0].url).toBe('http://h:1/v1/models')
  })

  test('redirects are not followed, so the key cannot be handed to another origin', async () => {
    const { fetchImpl, seen } = serve({})
    await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) expect(request.redirect).toBe('manual')
  })
})

describe('fetchCustomModels - what comes back', () => {
  test('duplicate ids collapse and order is kept', async () => {
    const { fetchImpl } = serve({ 'http://h:1/v1/models': () => openaiList('a', 'b', 'a') })
    expect(await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)).toEqual({
      ok: true,
      ids: ['a', 'b']
    })
  })

  test('a Google-shaped list is read too, with the models/ prefix removed', async () => {
    const { fetchImpl } = serve({
      'http://h:1/v1/models': () => Response.json({ models: [{ name: 'models/gemini-x' }] })
    })
    expect(await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)).toEqual({
      ok: true,
      ids: ['gemini-x']
    })
  })

  test('the sibling path is tried when the first has nothing, and its ids win', async () => {
    const { fetchImpl, seen } = serve({
      'http://h:1/v1/models': () => new Response('nope', { status: 404 }),
      'http://h:1/models': () => openaiList('only-here')
    })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({ ok: true, ids: ['only-here'] })
    expect(seen.map((s) => s.url)).toEqual(['http://h:1/v1/models', 'http://h:1/models'])
  })

  test('the first candidate answering is the last one asked', async () => {
    const { fetchImpl, seen } = serve({ 'http://h:1/v1/models': () => openaiList('m') })
    await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(seen).toHaveLength(1)
  })
})

describe('fetchCustomModels - fallback to manual entry', () => {
  test('a 401 is reported against the address the operator typed, not a guessed sibling', async () => {
    const { fetchImpl } = serve({
      'http://h:1/v1/models': () => new Response('denied', { status: 401 })
      // the sibling answers 404 by default
    })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'bad', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({ ok: false, error: 'http://h:1/v1/models returned HTTP 401' })
  })

  test('an empty list is a failure with its own reason', async () => {
    const { fetchImpl } = serve({ 'http://h:1/v1/models': () => openaiList() })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({ ok: false, error: 'http://h:1/v1/models listed no models' })
  })

  test('a JSON body of an unknown shape is a failure, not a crash', async () => {
    const { fetchImpl } = serve({ 'http://h:1/v1/models': () => Response.json({ hello: 'world' }) })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({ ok: false, error: 'http://h:1/v1/models returned an unrecognised response shape' })
  })

  test('a body that is not JSON is a failure, not a crash', async () => {
    const { fetchImpl } = serve({ 'http://h:1/v1/models': () => new Response('<html>hi</html>') })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result.ok).toBe(false)
  })

  test('a redirect is reported with its target and is not followed', async () => {
    const { fetchImpl, seen } = serve({
      'http://h:1/v1/models': () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/v1/models' } })
    })
    const result = await fetchCustomModels({ baseUrl: 'http://h:1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({
      ok: false,
      error: 'http://h:1/v1/models redirected to https://elsewhere.test/v1/models; use that address instead'
    })
    expect(seen.every((s) => !s.url.startsWith('https://elsewhere.test'))).toBe(true)
  })

  test('a connection error is reported with its message', async () => {
    const refuse: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1234')
    }
    const result = await fetchCustomModels(
      { baseUrl: 'http://localhost:1234', apiKey: 'k', style: 'openai_chat' },
      refuse
    )
    expect(result).toEqual({ ok: false, error: 'http://localhost:1234/v1/models: connect ECONNREFUSED 127.0.0.1:1234' })
  })

  test('a timeout is reported as such', async () => {
    const stall: typeof fetch = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }
    const result = await fetchCustomModels(
      { baseUrl: 'http://localhost:1234', apiKey: 'k', style: 'openai_chat' },
      stall
    )
    expect(result).toEqual({ ok: false, error: 'http://localhost:1234/v1/models did not answer in time' })
  })

  test('a Base URL that is not http(s) never reaches fetch', async () => {
    const { fetchImpl, seen } = serve({})
    const result = await fetchCustomModels({ baseUrl: 'ftp://h/v1', apiKey: 'k', style: 'openai_chat' }, fetchImpl)
    expect(result).toEqual({ ok: false, error: 'Base URL is not an http(s) address' })
    expect(seen).toHaveLength(0)
  })
})

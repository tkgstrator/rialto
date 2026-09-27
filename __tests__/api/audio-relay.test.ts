/**
 * /v1/audio/speech and /v1/audio/voices, relayed to the TTS server named
 * by RIALTO_TTS_URL. A local Bun server stands in for Irodori-TTS and
 * records what reached it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { audioRoute, ttsBaseUrl, upstreamUrl } from '../../src/api/v1/audio'

interface Seen {
  method: string
  path: string
  authorization: string | null
  body: string
}

const seen: Seen[] = []

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    seen.push({
      method: req.method,
      path: url.pathname + url.search,
      authorization: req.headers.get('authorization'),
      body: await req.text()
    })
    if (url.pathname === '/tts/v1/audio/voices') return Response.json({ data: [{ id: 'v1', cv: 'CV', name: 'N' }] })
    if (url.pathname === '/tts/v1/audio/speech') {
      return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        headers: { 'content-type': 'audio/mpeg', 'x-internal': 'secret' }
      })
    }
    return new Response('nope', { status: 404 })
  }
})

const call = (path: string, init: RequestInit = {}) => audioRoute.fetch(new Request(`http://local${path}`, init))

const speak = (body: unknown) =>
  call('/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rlt_client_secret' },
    body: JSON.stringify(body)
  })

describe('TTS relay', () => {
  const saved = process.env.RIALTO_TTS_URL

  beforeAll(() => {
    process.env.RIALTO_TTS_URL = `http://127.0.0.1:${upstream.port}/tts`
  })

  afterEach(() => {
    seen.length = 0
    process.env.RIALTO_TTS_URL = `http://127.0.0.1:${upstream.port}/tts`
  })

  afterAll(() => {
    upstream.stop(true)
    if (saved === undefined) delete process.env.RIALTO_TTS_URL
    else process.env.RIALTO_TTS_URL = saved
  })

  test('relays speech with its body, and passes the audio back', async () => {
    const res = await speak({ model: 'irodori', input: 'こんにちは', voice: 'v1', response_format: 'mp3' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x49, 0x44, 0x33]))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/tts/v1/audio/speech' })
    expect(JSON.parse(seen[0].body)).toMatchObject({ input: 'こんにちは', voice: 'v1' })
  })

  test('never forwards the client’s token, nor the upstream’s own headers', async () => {
    const res = await speak({ model: 'irodori', input: 'a', voice: 'v1' })
    expect(seen[0].authorization).toBeNull()
    expect(res.headers.get('x-internal')).toBeNull()
  })

  test('relays the voice list', async () => {
    const res = await call('/v1/audio/voices', { headers: { authorization: 'Bearer rlt_client_secret' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [{ id: 'v1', cv: 'CV', name: 'N' }] })
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/tts/v1/audio/voices', authorization: null })
  })

  test('answers 503 in the OpenAI envelope while no TTS server is configured', async () => {
    delete process.env.RIALTO_TTS_URL
    const res = await speak({ input: 'a' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining('not configured') } })
    expect(seen).toHaveLength(0)
  })

  test('answers 502 when the TTS server cannot be reached', async () => {
    process.env.RIALTO_TTS_URL = 'http://127.0.0.1:1'
    expect((await speak({ input: 'a' })).status).toBe(502)
  })

  test('refuses an oversized body without contacting the TTS server', async () => {
    const res = await speak({ input: 'あ'.repeat(40_000) })
    expect(res.status).toBe(413)
    expect(seen).toHaveLength(0)
  })

  test('reads the base URL strictly and keeps its path prefix', () => {
    process.env.RIALTO_TTS_URL = 'ftp://irodori-tts'
    expect(ttsBaseUrl()).toBeNull()
    process.env.RIALTO_TTS_URL = ' http://irodori-tts:8000/ '
    const base = ttsBaseUrl()
    expect(base?.host).toBe('irodori-tts:8000')
    if (base === null) throw new Error('unreachable')
    expect(upstreamUrl(base, '/v1/audio/speech').toString()).toBe('http://irodori-tts:8000/v1/audio/speech')
  })
})

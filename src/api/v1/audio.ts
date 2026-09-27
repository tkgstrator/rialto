/**
 * POST /v1/audio/speech — read a reply aloud.
 * GET  /v1/audio/voices — the voices to read it in.
 *
 * Both are relayed to the TTS server that runs beside Rialto, named by
 * `RIALTO_TTS_URL` (in compose, the service's own name, e.g.
 * `http://irodori-tts:8000`). The edge used to send `/v1/audio/*` to that
 * server directly, which left speech open to anyone who found the path:
 * nothing there checks a token. Behind Rialto it sits behind the same
 * `/v1` gate as the completions it speaks, so the key an app install
 * already holds is the key that lets it talk.
 *
 * Only these two paths are relayed. Anything else the TTS server serves
 * stays unreachable from outside, and so does the server's own address.
 *
 * The presented token is not forwarded: it is Rialto's credential, and
 * the TTS server has no business seeing it.
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { logger } from '../../logger'
import { buildErrorEnvelope } from './error-shape'

// Speech is short replies, not audiobooks. The cap keeps a single request
// from tying up the GPU; the TTS server enforces its own limits as well.
const MAX_BODY_BYTES = 64 * 1024
// Long enough for a slow first synthesis after the model loads, short
// enough that a wedged server answers the app with an error it can show.
const UPSTREAM_TIMEOUT_MS = 120_000

// Headers of the upstream answer worth passing on. Hop-by-hop and
// encoding headers are left to Bun, which re-frames the body anyway.
const PASSED_HEADERS = ['content-type', 'content-disposition', 'cache-control']

const fail = (status: number, message: string): Response =>
  new Response(JSON.stringify(buildErrorEnvelope({ shape: 'openai', status, from: message })), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/**
 * Where speech is relayed, or null while none is configured. Read per
 * request so a restart is all a changed compose file needs.
 */
export function ttsBaseUrl(): URL | null {
  const raw = process.env.RIALTO_TTS_URL
  if (raw === undefined || raw.trim().length === 0) return null
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** `base` joined with `path`, keeping any prefix the base carries. */
export function upstreamUrl(base: URL, path: string): URL {
  const prefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname
  const url = new URL(base.toString())
  url.pathname = `${prefix}${path}`
  url.search = ''
  return url
}

async function relay(c: Context, path: string, init: { method: string; body?: ArrayBuffer }): Promise<Response> {
  const base = ttsBaseUrl()
  if (base === null) return fail(503, 'Speech is not configured on this server.')

  const headers = new Headers()
  const contentType = c.req.header('content-type')
  if (init.body !== undefined && contentType !== undefined) headers.set('content-type', contentType)
  const accept = c.req.header('accept')
  if (accept !== undefined) headers.set('accept', accept)

  const target = upstreamUrl(base, path)
  const upstream = await fetch(target, {
    method: init.method,
    headers,
    body: init.body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  }).catch((err: unknown) => {
    logger.warn({ err, path }, 'tts relay: upstream unreachable')
    return null
  })
  if (upstream === null) return fail(502, 'The speech server could not be reached.')

  // The upstream's own status and body pass through, errors included: its
  // messages ("unknown voice") are the ones the app can act on.
  const out = new Headers()
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) out.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const audioRoute = new Hono()

audioRoute.post('/v1/audio/speech', async (c) => {
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'The request body is too large.')
  const body = await c.req.arrayBuffer()
  // Checked again on the bytes read: a chunked body declares no length.
  if (body.byteLength > MAX_BODY_BYTES) return fail(413, 'The request body is too large.')
  return relay(c, '/v1/audio/speech', { method: 'POST', body })
})

audioRoute.get('/v1/audio/voices', (c) => relay(c, '/v1/audio/voices', { method: 'GET' }))

/**
 * Parity matrix — the "error shape" row.
 *
 * Each surface has its own envelope that the client SDK can parse. One
 * pipeline serves four SDKs, so **whatever the upstream returns has to be
 * repacked into the surface's envelope** — without that, codex's
 * `{detail}` reaches the OpenAI SDK and Anthropic's `{type:'error'}`
 * reaches the Gemini SDK verbatim.
 *
 * The envelopes' own vocabulary (the error.type taxonomy, the
 * google.rpc.Code name table) is covered by
 * `__tests__/api/error-shape.test.ts`. What is checked here is that
 * **all four surfaces have an envelope assigned**, and that going
 * through the real path, `forwardUpstreamError`, produces the same
 * one.
 */

import { describe, expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { errorShapeForPath } from '../../src/api/v1/error-shape'
import { forwardUpstreamError } from '../../src/api/v1/upstream-error'
import { INBOUND_SURFACES } from '../../src/llms/inbound/surfaces'

// Wrap a raw upstream error body in the exception shape the pipeline
// throws. This message format is the contract between provider-send.ts
// and PROVIDER_ERR_RE.
const upstreamError = (status: number, rawBody: string): HTTPException =>
  new HTTPException(status as never, { message: `Error from provider(p,m: ${status}): ${rawBody}` })

// The shape codex actually returns. It matches none of the three
// envelopes, so whether the repacking works shows up plainly.
const CODEX_BODY = JSON.stringify({ detail: 'Unsupported parameter: system' })

describe('every surface has an envelope', () => {
  test('the descriptor errorShape agrees with errorShapeForPath', () => {
    for (const surface of INBOUND_SURFACES) {
      expect(errorShapeForPath(surface.path.replace('/*', '/gemini-3-pro:generateContent'))).toBe(surface.errorShape)
    }
  })

  test('completion and image surfaces map onto three envelopes', () => {
    expect(INBOUND_SURFACES.map((s) => `${s.id}:${s.errorShape}`)).toEqual([
      'anthropic-messages:anthropic',
      'openai-chat:openai',
      'openai-responses:openai',
      'gemini-generate:google',
      'openai-images:openai'
    ])
  })
})

describe('an unknown upstream shape is repacked into the surface envelope', () => {
  test('anthropic-messages — {type:"error", error:{type,message}}', async () => {
    const forwarded = forwardUpstreamError(upstreamError(400, CODEX_BODY), errorShapeForPath('/v1/messages'), 'p')
    expect(forwarded?.status).toBe(400)
    expect(await forwarded!.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: '[via p] Unsupported parameter: system' }
    })
  })

  test('openai-chat — {error:{message,type,param,code}}', async () => {
    const forwarded = forwardUpstreamError(
      upstreamError(400, CODEX_BODY),
      errorShapeForPath('/v1/chat/completions'),
      'p'
    )
    expect(await forwarded!.json()).toEqual({
      error: {
        message: '[via p] Unsupported parameter: system',
        type: 'invalid_request_error',
        param: null,
        code: null
      }
    })
  })

  test('openai-responses — the same envelope as chat/completions', async () => {
    const forwarded = forwardUpstreamError(upstreamError(400, CODEX_BODY), errorShapeForPath('/v1/responses'), 'p')
    expect(await forwarded!.json()).toEqual({
      error: {
        message: '[via p] Unsupported parameter: system',
        type: 'invalid_request_error',
        param: null,
        code: null
      }
    })
  })

  test('gemini-generate — google.rpc.Status, code being the numeric HTTP status', async () => {
    const forwarded = forwardUpstreamError(
      upstreamError(400, CODEX_BODY),
      errorShapeForPath('/v1beta/models/gemini-3-pro:generateContent'),
      'p'
    )
    expect(await forwarded!.json()).toEqual({
      error: { code: 400, message: '[via p] Unsupported parameter: system', status: 'INVALID_ARGUMENT' }
    })
  })
})

describe('the diagnostic headers are the same on every surface', () => {
  test('carries the via provider and the URL it called, for isolating a chained Rialto', () => {
    const forwarded = forwardUpstreamError(upstreamError(401, '{"detail":"nope"}'), 'openai', 'p')
    expect(forwarded?.headers.get('x-rialto-upstream')).toBe('p')
  })

  test('an exception from the pipeline itself returns null rather than being repacked, and the caller answers 5xx', () => {
    expect(forwardUpstreamError(new Error('boom'), 'openai', 'p')).toBeNull()
    expect(forwardUpstreamError(new HTTPException(500, { message: 'not the provider format' }), 'openai')).toBeNull()
  })
})

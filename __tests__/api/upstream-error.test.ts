/**
 * `forwardUpstreamError` — end-to-end Response-level assertions.
 *
 * The `via` provider tag and the `x-rialto-upstream-url` diagnostic header
 * both round-trip an out-of-band signal from `sendToProvider` (where the
 * outbound URL and provider are known) up to the /v1 error path (where
 * the client-facing Response is built). Verify the wire-observable
 * behaviour so a future refactor of either side can't silently drop the
 * plumbing that closes the "which hop returned this 401" gap.
 */

import { describe, expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import {
  bestSupportedLevel,
  deepReplaceValue,
  forwardUpstreamError,
  isInsufficientQuota,
  isRateLimited
} from '../../src/api/v1/upstream-error'
import { stripUrlSecrets, UPSTREAM_URL_SYMBOL } from '../../src/llms/pipeline/provider-send'

// Reproduce the exception shape sendToProvider throws on upstream error:
// the `Error from provider(...)` message wrap plus the symbol-keyed
// URL. Local helper because the real send path pulls in the whole
// pipeline; the exception's contract is what forwardUpstreamError reads.
function makeUpstreamException(
  status: number,
  providerName: string,
  model: string,
  body: string,
  url?: string
): HTTPException {
  const message = `Error from provider(${providerName},${model}: ${status}): ${body}`
  // biome-ignore plugin: HTTPException's status param is typed as a closed union of supported codes.
  const exc = new HTTPException(status as never, { message })
  if (url !== undefined) {
    ;(exc as unknown as Record<symbol, unknown>)[UPSTREAM_URL_SYMBOL] = url
  }
  return exc
}

describe('stripUrlSecrets', () => {
  test('drops query params (Gemini ?key=<apiKey> leak)', () => {
    expect(
      stripUrlSecrets(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=abc123'
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
  })

  test('leaves host + path untouched when there is no query', () => {
    expect(stripUrlSecrets('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })

  test('accepts a URL object', () => {
    const u = new URL('https://api.openai.com/v1/chat/completions?debug=1')
    expect(stripUrlSecrets(u)).toBe('https://api.openai.com/v1/chat/completions')
  })

  test('malformed input still drops anything past the first ?', () => {
    // Fallback path — URL constructor throws on this, so the manual
    // '?' split protects against key leakage even then.
    expect(stripUrlSecrets('not-a-url?key=leak')).toBe('not-a-url')
  })
})

describe('forwardUpstreamError — via + x-rialto-upstream-url headers', () => {
  test('emits both headers when the exception carries a URL', () => {
    const err = makeUpstreamException(
      401,
      'openai',
      'gpt-5.6-luna',
      '{"error":{"message":"boom","type":"invalid_request_error"}}',
      'https://api.openai.com/v1/chat/completions'
    )
    const res = forwardUpstreamError(err, 'openai', 'openai')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
    expect(res!.headers.get('x-rialto-upstream')).toBe('openai')
    expect(res!.headers.get('x-rialto-upstream-url')).toBe('https://api.openai.com/v1/chat/completions')
  })

  test('omits x-rialto-upstream-url when the exception did not attach one', () => {
    const err = makeUpstreamException(500, 'openai', 'gpt-5-nano', 'oops')
    const res = forwardUpstreamError(err, 'openai', 'openai')
    expect(res).not.toBeNull()
    expect(res!.headers.get('x-rialto-upstream')).toBe('openai')
    expect(res!.headers.get('x-rialto-upstream-url')).toBeNull()
  })

  test('returns null for non-HTTPException errors (caller falls back to 5xx envelope)', () => {
    expect(forwardUpstreamError(new Error('boom'), 'openai', 'openai')).toBeNull()
  })

  test('returns null when the message does not match the provider-shaped envelope', () => {
    // biome-ignore plugin: intentional out-of-shape input for negative test.
    const err = new HTTPException(500 as never, { message: 'unrelated error' })
    expect(forwardUpstreamError(err, 'openai', 'openai')).toBeNull()
  })
})

describe('isInsufficientQuota', () => {
  // Real-shape OpenAI 429 body captured from prod when a project hits
  // its enforced spend limit. The router must distinguish this from an
  // ephemeral rate-limit tick so the chain walker can mark the whole
  // provider exhausted and skip the ~5 minutes of same-provider
  // fallbacks that otherwise pile up before AbortSignal.timeout fires.
  const QUOTA_BODY = JSON.stringify({
    error: {
      message: 'Your project has reached its configured enforced spend limit.',
      type: 'insufficient_quota',
      code: 'insufficient_quota'
    }
  })

  test('detects OpenAI insufficient_quota 429 (permanent spend-cap)', () => {
    const err = makeUpstreamException(429, 'openai', 'gpt-5.6-luna', QUOTA_BODY)
    expect(isInsufficientQuota(err)).toBe(true)
    // Still counts as rate-limited so the base failover path still fires.
    expect(isRateLimited(err)).toBe(true)
  })

  test('rejects a plain rate_limit 429 (ephemeral)', () => {
    const body = JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_exceeded' } })
    const err = makeUpstreamException(429, 'openai', 'gpt-5.6-luna', body)
    expect(isInsufficientQuota(err)).toBe(false)
  })

  test('rejects a 429 with a malformed body (safe default = false)', () => {
    const err = makeUpstreamException(429, 'openai', 'gpt-5.6-luna', 'not json')
    expect(isInsufficientQuota(err)).toBe(false)
  })

  test('rejects non-HTTPException errors', () => {
    expect(isInsufficientQuota(new Error('boom'))).toBe(false)
  })
})

// The correction applied once to an effort level the upstream refuses. It
// picks the highest level the message lists, but never `max`: a correction
// Rialto makes on its own must not raise the caller's level to the costliest
// setting.
describe('bestSupportedLevel', () => {
  test('reads the refused level and the highest listed level below max', () => {
    const message = "This model does not support effort level 'xhigh'. Supported levels: low, medium, high, max"
    expect(bestSupportedLevel(message)).toEqual({ bad: 'xhigh', level: 'high' })
  })

  test('still picks the highest of the rest when max is not listed', () => {
    const message = "does not support effort level 'max'. Supported levels: low, medium, high, xhigh"
    expect(bestSupportedLevel(message)).toEqual({ bad: 'max', level: 'xhigh' })
  })

  test('is order-independent about where max sits in the list', () => {
    const message = "does not support effort level 'xhigh'. Supported levels: max, low, high, medium"
    expect(bestSupportedLevel(message)).toEqual({ bad: 'xhigh', level: 'high' })
  })

  test('returns null when max is the only listed level, so the original error is forwarded', () => {
    expect(bestSupportedLevel("does not support effort level 'xhigh'. Supported levels: max")).toBeNull()
  })

  test('reads the message out of the wrapped upstream error body', () => {
    const wrapped =
      'Error from provider(claude-code,claude-sonnet-4-6: 400): ' +
      '{"type":"error","error":{"message":"does not support effort level \'xhigh\'. Supported levels: low, high"}}'
    expect(bestSupportedLevel(wrapped)).toEqual({ bad: 'xhigh', level: 'high' })
  })

  test('returns null for any other message, leaving the original error to be forwarded', () => {
    expect(bestSupportedLevel(undefined)).toBeNull()
    expect(bestSupportedLevel('')).toBeNull()
    expect(bestSupportedLevel('effort is not supported by this model')).toBeNull()
  })
})

describe('deepReplaceValue', () => {
  test('rewrites every slot holding the refused level, nested ones included', () => {
    const body = { output_config: { effort: 'xhigh' }, extra: [{ effort: 'xhigh' }, { effort: 'low' }] }
    expect(deepReplaceValue(body, 'xhigh', 'high')).toBe(true)
    expect(body).toEqual({ output_config: { effort: 'high' }, extra: [{ effort: 'high' }, { effort: 'low' }] })
  })

  test('reports no change when the level is not in the body, so no retry is spent', () => {
    expect(deepReplaceValue({ output_config: { effort: 'low' } }, 'xhigh', 'high')).toBe(false)
  })
})

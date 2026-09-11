/**
 * Tests for the Codex device-code upstream calls
 * (src/services/codex-auth/device-code.ts).
 *
 * Protocol pinned from openai/codex codex-rs/login/src/device_code_auth.rs
 * at commit d4fcb2873bf23464cfacd804a31d46529db943b0 — see the comment at
 * the top of device-code.ts for the endpoint-by-endpoint summary. These
 * tests exist to catch a drift from that source, not to re-derive it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  exchangeCodexDeviceCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode
} from '../../src/services/codex-auth/device-code'
import { CODEX_CLIENT_ID } from '../../src/services/codex-auth/oauth'

const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
const TOKEN_POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token'
const TOKEN_EXCHANGE_URL = 'https://auth.openai.com/oauth/token'

const originalFetch = globalThis.fetch

interface Captured {
  url: string
  body: string
}
const calls: Captured[] = []

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const stub = (routes: Record<string, (call: Captured) => Response>): void => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Captured = { url: urlOf(input), body: typeof init?.body === 'string' ? init.body : '' }
    calls.push(call)
    const respond = routes[call.url]
    if (respond === undefined) throw new Error(`unexpected fetch to ${call.url}`)
    return respond(call)
  }
  globalThis.fetch = fake as typeof globalThis.fetch
}

describe('requestCodexDeviceCode', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    calls.length = 0
  })

  test('sends the CLI client_id and builds the verification URL itself', async () => {
    stub({
      [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_1', user_code: 'KQ7M-P4TZ', interval: '5' })
    })

    const code = await requestCodexDeviceCode()

    expect(code).toEqual({
      deviceAuthId: 'da_1',
      userCode: 'KQ7M-P4TZ',
      // Never read off the wire — the CLI builds this itself, and so do we.
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5
    })
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].body)).toEqual({ client_id: CODEX_CLIENT_ID })
  })

  test('accepts the `usercode` alias the server may use instead of `user_code`', async () => {
    stub({ [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_2', usercode: 'ABCD-1234', interval: 3 }) })

    const code = await requestCodexDeviceCode()

    expect(code.userCode).toBe('ABCD-1234')
    expect(code.intervalSeconds).toBe(3)
  })

  test('falls back to a default interval when the field is absent', async () => {
    stub({ [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_3', user_code: 'ZZZZ-9999' }) })

    const code = await requestCodexDeviceCode()

    expect(code.intervalSeconds).toBeGreaterThan(0)
  })

  test('throws when the response carries neither user_code nor usercode', async () => {
    stub({ [USERCODE_URL]: () => jsonResponse({ device_auth_id: 'da_4' }) })
    await expect(requestCodexDeviceCode()).rejects.toThrow('user_code')
  })

  test('throws on a non-2xx response', async () => {
    stub({ [USERCODE_URL]: () => jsonResponse({ error: 'server_error' }, 500) })
    await expect(requestCodexDeviceCode()).rejects.toThrow('500')
  })
})

describe('pollCodexDeviceCode', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    calls.length = 0
  })

  test('403 reads as still pending', async () => {
    stub({ [TOKEN_POLL_URL]: () => jsonResponse({}, 403) })
    const result = await pollCodexDeviceCode({ deviceAuthId: 'da', userCode: 'CODE' })
    expect(result).toEqual({ status: 'pending' })
  })

  test('404 also reads as still pending', async () => {
    stub({ [TOKEN_POLL_URL]: () => jsonResponse({}, 404) })
    const result = await pollCodexDeviceCode({ deviceAuthId: 'da', userCode: 'CODE' })
    expect(result).toEqual({ status: 'pending' })
  })

  test('200 returns the authorization code and the server-minted code_verifier', async () => {
    stub({
      [TOKEN_POLL_URL]: (call) => {
        expect(JSON.parse(call.body)).toEqual({ device_auth_id: 'da', user_code: 'CODE' })
        return jsonResponse({
          authorization_code: 'ac_device',
          code_challenge: 'challenge',
          code_verifier: 'verifier-from-server'
        })
      }
    })

    const result = await pollCodexDeviceCode({ deviceAuthId: 'da', userCode: 'CODE' })

    expect(result).toEqual({ status: 'authorized', code: 'ac_device', codeVerifier: 'verifier-from-server' })
  })

  test('any other status is a hard failure', async () => {
    stub({ [TOKEN_POLL_URL]: () => jsonResponse({ error: 'server_error' }, 500) })
    const result = await pollCodexDeviceCode({ deviceAuthId: 'da', userCode: 'CODE' })
    expect(result.status).toBe('error')
  })
})

describe('exchangeCodexDeviceCode', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    calls.length = 0
  })

  test('exchanges at the ordinary token endpoint with the device-auth redirect_uri', async () => {
    stub({
      [TOKEN_EXCHANGE_URL]: () => jsonResponse({ access_token: 'at', refresh_token: 'rt', id_token: 'it' })
    })

    const tokens = await exchangeCodexDeviceCode({ code: 'ac_device', codeVerifier: 'verifier-from-server' })

    expect(tokens).toEqual({ access_token: 'at', refresh_token: 'rt', id_token: 'it' })
    const sent = new URLSearchParams(calls[0].body)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('code')).toBe('ac_device')
    expect(sent.get('code_verifier')).toBe('verifier-from-server')
    // NOT the loopback callback the browser flow uses — the device flow's
    // authorize step never happened on this host, so the redirect_uri the
    // token endpoint expects is the device-auth endpoint's own.
    expect(sent.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
    expect(sent.get('client_id')).toBe(CODEX_CLIENT_ID)
  })
})

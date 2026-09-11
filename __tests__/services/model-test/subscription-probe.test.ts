/**
 * The Codex subscription probe's request, built by the proxy's own chain.
 *
 * Pinned because the hand-written body it replaced sent max_output_tokens,
 * which the ChatGPT backend refuses: every Codex model test failed while
 * the proxy served the same models, because the proxy strips the field.
 */

import { describe, expect, test } from 'bun:test'
import dayjs from '../../../src/lib/dayjs'
import { buildCodexRequest } from '../../../src/services/model-test/subscription-probe'

const BASE = 'https://chatgpt.com/backend-api/codex'
const MODEL = 'gpt-5.6-terra'

// Not a JWT, far from its stored expiry and with no refresh token, so the
// freshness check keeps it as is and building the request stays offline.
const overlay = {
  subAccountId: 'acct-codex',
  accessToken: 'tok-codex',
  refreshToken: null,
  accountId: 'chatgpt-account-1',
  expiresAt: dayjs().add(1, 'day').toDate()
}

describe('buildCodexRequest', () => {
  test('sends no output ceiling, which the backend refuses, and no chat-completions fields', async () => {
    const built = await buildCodexRequest(overlay, 'codex', BASE, MODEL)
    const body: Record<string, unknown> = JSON.parse(built.body)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    expect(body.messages).toBeUndefined()
    expect(body.model).toBe(MODEL)
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(JSON.stringify(body.input)).toContain('ping')
  })

  test('goes to the backend /responses endpoint with the account credentials and client headers', async () => {
    const built = await buildCodexRequest(overlay, 'codex', BASE, MODEL)
    expect(built.url).toBe(`${BASE}/responses`)
    expect(built.headers.Authorization).toBe('Bearer tok-codex')
    expect(built.headers['chatgpt-account-id']).toBe('chatgpt-account-1')
    expect(built.headers.originator).toBe('codex_cli')
  })
})

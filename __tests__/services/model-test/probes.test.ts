/**
 * The api_key Responses probe keeps its output ceiling.
 *
 * The public Responses API takes max_output_tokens and 400s below 16, so
 * this probe sends 16 — the opposite of the Codex subscription backend,
 * which refuses the field and is probed through its own chain. Pinning
 * both sides keeps either from being "fixed" into the other.
 */

import { afterEach, expect, test } from 'bun:test'
import { ApiStyle } from '../../../src/generated/prisma/client'
import { probeInference } from '../../../src/services/model-test/probes'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('an api_key Responses probe sends max_output_tokens 16 to /responses', async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = []
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') })
    return new Response('event: response.created\n\n', { status: 200 })
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })

  const result = await probeInference(
    ApiStyle.openai_responses,
    'https://api.openai.com/v1/chat/completions',
    'sk-test',
    'gpt-5.5'
  )

  expect(result).toEqual({ ok: true })
  expect(seen.map((s) => s.url)).toEqual(['https://api.openai.com/v1/responses'])
  expect(seen[0].body.max_output_tokens).toBe(16)
})

// One provider hosts models on both wire formats and keeps a single Base
// URL, which may name either endpoint. The probe sends to the endpoint of the
// style the model resolved to, so a test button agrees with the real request.
const urlsProbed = async (style: ApiStyle, baseUrl: string): Promise<string[]> => {
  const seen: string[] = []
  const fake = async (input: string | URL | Request): Promise<Response> => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response('{}', { status: 200 })
  }
  globalThis.fetch = Object.assign(fake, { preconnect: originalFetch.preconnect })
  const result = await probeInference(style, baseUrl, 'sk-test', 'gpt-6-astra')
  expect(result).toEqual({ ok: true })
  return seen
}

const CHAT = 'https://api.openai.com/v1/chat/completions'
const RESPONSES = 'https://api.openai.com/v1/responses'

test('a Chat probe on a Responses Base URL goes to /chat/completions', async () => {
  expect(await urlsProbed(ApiStyle.openai_chat, RESPONSES)).toEqual([CHAT])
})

test('a Chat probe on a Chat Base URL, or one naming neither, goes where the URL says', async () => {
  expect(await urlsProbed(ApiStyle.openai_chat, CHAT)).toEqual([CHAT])
  expect(await urlsProbed(ApiStyle.openai_chat, 'https://proxy.example/v1/foo')).toEqual([
    'https://proxy.example/v1/foo'
  ])
})

test('a Responses probe on a Responses Base URL keeps it, slash and query included', async () => {
  expect(await urlsProbed(ApiStyle.openai_responses, RESPONSES)).toEqual([RESPONSES])
  expect(await urlsProbed(ApiStyle.openai_responses, `${RESPONSES}/`)).toEqual([`${RESPONSES}/`])
  expect(await urlsProbed(ApiStyle.openai_responses, `${CHAT}?api-version=1`)).toEqual([`${RESPONSES}?api-version=1`])
})

test('a Responses probe on a Base URL naming neither endpoint appends /responses', async () => {
  expect(await urlsProbed(ApiStyle.openai_responses, 'https://proxy.example/v1/')).toEqual([
    'https://proxy.example/v1/responses'
  ])
})

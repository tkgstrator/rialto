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

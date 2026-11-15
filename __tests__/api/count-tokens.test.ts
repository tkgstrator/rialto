/**
 * POST /v1/messages/count_tokens — Anthropic's up-front size estimate.
 *
 * Claude Code uses it to decide when to compact a conversation. While it
 * was unimplemented the fail-closed `/v1/*` lane answered 404, and
 * context management degraded silently: the client keeps sending until
 * the upstream refuses.
 *
 * Pinned above all: **it must not 400 on a tool shape Rialto does not
 * model**. This is hit in practice: Claude Code's server tools
 * (`web_search_*`) carry no `input_schema`, so validating naively rejects
 * them.
 */

import { describe, expect, test } from 'bun:test'
import { countTokensRoute } from '../../src/api/v1/count-tokens'
import { CATALOG_PATHS } from '../../src/llms/inbound/surfaces'

const call = (body: unknown): Promise<Response> =>
  countTokensRoute.fetch(
    new Request('http://local/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  )

const countOf = async (body: unknown): Promise<number> => {
  const res = await call(body)
  expect(res.status).toBe(200)
  const json = (await res.json()) as { input_tokens: number }
  return json.input_tokens
}

describe('POST /v1/messages/count_tokens', () => {
  test('counts the message body', async () => {
    const n = await countOf({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello world' }]
    })
    expect(n).toBeGreaterThan(0)
  })

  test('more text means a larger count', async () => {
    const short = await countOf({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const long = await countOf({
      model: 'm',
      messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(200) }]
    })
    expect(long).toBeGreaterThan(short * 10)
  })

  test('the system prompt counts too', async () => {
    const withoutSystem = await countOf({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const withSystem = await countOf({
      model: 'm',
      system: 'You are a terse assistant that answers in one word.',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(withSystem).toBeGreaterThan(withoutSystem)
  })

  test('tools count toward the total', async () => {
    const withoutTools = await countOf({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const withTools = await countOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace and return its contents.',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      ]
    })
    expect(withTools).toBeGreaterThan(withoutTools)
  })

  test('does not 400 on a server tool with no input_schema', async () => {
    // The shape Claude Code actually sends. Rejecting it here would mean
    // the proxy breaking a request the upstream would have accepted.
    const res = await call({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
    expect(res.status).toBe(200)
  })

  test('answers even with no messages', async () => {
    // Anthropic itself returns 400 here, but a 500 from us would be
    // worse.
    const res = await call({ model: 'm' })
    expect(res.status).toBe(200)
  })

  test('a body that is not a JSON object gets 400 in the Anthropic envelope', async () => {
    for (const body of ['[]', 'null', '"nope"', 'not json at all']) {
      const res = await call(body)
      expect(res.status).toBe(400)
      const json = (await res.json()) as { type: string; error: { type: string } }
      expect(json.type).toBe('error')
      expect(json.error.type).toBe('invalid_request_error')
    }
  })
})

describe('registration in the surface registry', () => {
  test('listed in CATALOG_PATHS with x-api-key and the anthropic envelope', async () => {
    // Not an InboundSurface, since it completes nothing — but the auth
    // gate and the error envelope are derived from this entry. Drop it
    // and a 401 comes back in OpenAI shape, which the Anthropic SDK
    // cannot read.
    const entry = CATALOG_PATHS.find((p) => p.path === '/v1/messages/count_tokens')
    expect(entry).toBeDefined()
    expect(entry?.auth).toBe('x-api-key')
    expect(entry?.errorShape).toBe('anthropic')
  })
})

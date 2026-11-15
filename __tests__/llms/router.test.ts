/**
 * What `routeRequest` does to a request before it is dispatched, and which
 * vendor's windows a 429 is charged to.
 *
 * Rialto sends the model the caller names, so the router never rewrites
 * `body.model`: it strips the Rialto subagent tag, stamps the facts the
 * failover path and the usage record read, and (on /v1/messages) appends
 * the active persona. The persona gate has its own file.
 */

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { type RouterRequest, routeRequest, subscriptionKindOf } from '../../src/llms/router'
import type { RouterRequestBody } from '../../src/llms/router/types'

// ---- which usage window a 429 is charged to ------------------------

describe('subscriptionKindOf', () => {
  const providers = [
    { name: 'claude-code', auth_mode: 'subscription', api_base_url: 'https://api.anthropic.com/v1/messages' },
    { name: 'codex', auth_mode: 'subscription', api_base_url: 'https://chatgpt.com/backend-api/codex' },
    { name: 'openai-sub', auth_mode: 'subscription', api_base_url: 'https://api.openai.com/v1/responses' },
    { name: 'anthropic', auth_mode: 'api_key', api_base_url: 'https://api.anthropic.com/v1/messages' },
    { name: 'elsewhere', auth_mode: 'subscription', api_base_url: 'https://example.invalid/v1' }
  ]

  test('a subscription provider is charged to its vendor by base URL', () => {
    expect(subscriptionKindOf('claude-code', providers)).toBe('claude')
    expect(subscriptionKindOf('codex', providers)).toBe('codex')
    expect(subscriptionKindOf('openai-sub', providers)).toBe('codex')
  })

  test('an api_key provider has no subscription windows, whatever its URL', () => {
    expect(subscriptionKindOf('anthropic', providers)).toBeNull()
  })

  test('an unknown vendor or an unknown provider is null rather than a guess', () => {
    expect(subscriptionKindOf('elsewhere', providers)).toBeNull()
    expect(subscriptionKindOf('missing', providers)).toBeNull()
  })
})

// ---- routeRequest ---------------------------------------------------

const log = pino({ level: 'silent' })

function route(
  system: RouterRequestBody['system'],
  model = 'claude-sonnet-4-5',
  inboundPath = '/v1/messages'
): RouterRequest {
  const req: RouterRequest = {
    body: { model, messages: [{ role: 'user', content: 'hi' }], system },
    log,
    inboundPath
  }
  routeRequest(req, { config: new ConfigStore({}) })
  return req
}

const systemWith = (second: string, first = 'preamble') => [
  { type: 'text', text: first },
  { type: 'text', text: second }
]

const textOf = (system: RouterRequestBody['system'], index: number): string | undefined => {
  const text = Array.isArray(system) ? system[index]?.text : undefined
  return typeof text === 'string' ? text : undefined
}

describe('routeRequest', () => {
  test('keeps the caller’s model and records the request as passthrough with no fallbacks', () => {
    for (const inboundPath of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
      const req = route(undefined, 'anthropic,claude-sonnet-5', inboundPath)
      expect(req.body.model).toBe('anthropic,claude-sonnet-5')
      expect(req.route).toBe('passthrough')
      expect(req.resolvedFallbacks).toEqual([])
    }
  })
})

describe('routeRequest: the subagent tag', () => {
  test('is recorded and stripped, and the model is untouched', () => {
    const plain = route(systemWith('You are a helpful assistant.'))
    const tagged = route(systemWith('<RIALTO-SUBAGENT-MODEL>anything</RIALTO-SUBAGENT-MODEL>'))
    expect(plain.isSubagent).toBe(false)
    expect(tagged.isSubagent).toBe(true)
    expect(tagged.body.model).toBe('claude-sonnet-4-5')
    expect(textOf(tagged.body.system, 1)).toBe('')
  })

  test('the legacy CCR spelling is still accepted', () => {
    const req = route(systemWith('<CCR-SUBAGENT-MODEL>x</CCR-SUBAGENT-MODEL>'))
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('')
  })

  test('its value is ignored, even when it names a real target', () => {
    // The tag body used to be a `provider,model` pair. Honouring it would
    // send the request somewhere the caller did not name; only its
    // presence is read.
    const req = route(systemWith('<RIALTO-SUBAGENT-MODEL>claude-code,claude-sonnet-5</RIALTO-SUBAGENT-MODEL>'))
    expect(req.body.model).toBe('claude-sonnet-4-5')
  })

  test('an unclosed tag still counts as present and is left as sent', () => {
    const req = route(systemWith('<RIALTO-SUBAGENT-MODEL>anthropic,x'))
    expect(req.isSubagent).toBe(true)
    expect(textOf(req.body.system, 1)).toBe('<RIALTO-SUBAGENT-MODEL>anthropic,x')
  })

  test('a tag outside the second system block is not a marker', () => {
    const req = route(systemWith('sys', '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>'))
    expect(req.isSubagent).toBe(false)
  })

  test('a single-block system cannot carry the tag', () => {
    const req = route([{ type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }])
    expect(req.isSubagent).toBe(false)
  })
})

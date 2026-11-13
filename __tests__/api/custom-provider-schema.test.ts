/**
 * The request and response envelopes of POST /api/providers/custom.
 *
 * The issue `message` is the problem code the Connect form maps to its own
 * wording, so the codes are part of the contract and are pinned here along
 * with the three wire formats, which must never include `gemini`.
 */
import { describe, expect, test } from 'bun:test'
import {
  CustomModelsLookupSchema,
  CustomProviderCreateRequestSchema,
  CustomProviderCreateResponseSchema
} from '../../src/schemas/api/providers'

const body = (over: Record<string, unknown> = {}) => ({
  name: 'lm-studio',
  base_url: 'http://localhost:1234/v1',
  api_key: 'lm-studio',
  api_style: 'openai_chat',
  ...over
})

// path -> problem code, for every issue the schema raised
const issues = (input: unknown): Record<string, string> => {
  const result = CustomProviderCreateRequestSchema.safeParse(input)
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
}

describe('CustomProviderCreateRequestSchema', () => {
  test('a complete body parses', () => {
    expect(CustomProviderCreateRequestSchema.safeParse(body()).success).toBe(true)
  })

  test.each(['anthropic', 'openai_chat', 'openai_responses'])('accepts the %s format', (api_style) => {
    expect(CustomProviderCreateRequestSchema.safeParse(body({ api_style })).success).toBe(true)
  })

  test('refuses gemini and anything else that is not one of the three', () => {
    expect(CustomProviderCreateRequestSchema.safeParse(body({ api_style: 'gemini' })).success).toBe(false)
    expect(CustomProviderCreateRequestSchema.safeParse(body({ api_style: 'openai' })).success).toBe(false)
  })

  test('has no auth mode to set: it is always api_key', () => {
    const parsed = CustomProviderCreateRequestSchema.safeParse(body({ auth_mode: 'subscription' }))
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'auth_mode' in parsed.data).toBe(false)
  })

  test.each([
    ['too_long', 'a'.repeat(49)],
    ['charset', 'My Gateway'],
    ['reserved', 'anthropic'],
    ['reserved', 'claude-code-proxy']
  ])('a name problem arrives as the code %s', (code, name) => {
    expect(issues(body({ name }))).toEqual({ name: code })
  })

  test('a blank name is "empty"', () => {
    expect(issues(body({ name: '   ' }))).toEqual({ name: 'empty' })
  })

  test.each([
    ['no scheme', 'localhost:1234'],
    ['ftp', 'ftp://h/v1'],
    ['credentials in the URL', 'http://u:p@h/v1'],
    ['a query', 'http://h/v1?key=1']
  ])('a Base URL with %s arrives as invalid_base_url', (_label, base_url) => {
    expect(issues(body({ base_url }))).toEqual({ base_url: 'invalid_base_url' })
  })

  test('both problems are reported together', () => {
    expect(issues(body({ name: 'openai', base_url: 'nope' }))).toEqual({
      name: 'reserved',
      base_url: 'invalid_base_url'
    })
  })

  test('the API key is required: a keyless provider is never called', () => {
    expect(CustomProviderCreateRequestSchema.safeParse(body({ api_key: '' })).success).toBe(false)
    expect(CustomProviderCreateRequestSchema.safeParse(body({ api_key: '   ' })).success).toBe(false)
    const { api_key: _omitted, ...withoutKey } = body()
    expect(CustomProviderCreateRequestSchema.safeParse(withoutKey).success).toBe(false)
  })

  test('private and loopback addresses are allowed', () => {
    expect(CustomProviderCreateRequestSchema.safeParse(body({ base_url: 'http://127.0.0.1:11434' })).success).toBe(true)
    expect(CustomProviderCreateRequestSchema.safeParse(body({ base_url: 'http://10.0.0.5/v1' })).success).toBe(true)
  })
})

describe('CustomModelsLookupSchema', () => {
  test('found carries a positive count', () => {
    expect(CustomModelsLookupSchema.safeParse({ status: 'found', count: 3 }).success).toBe(true)
    expect(CustomModelsLookupSchema.safeParse({ status: 'found', count: 0 }).success).toBe(false)
  })

  test('unavailable carries the reason the endpoint gave', () => {
    expect(CustomModelsLookupSchema.safeParse({ status: 'unavailable', error: 'HTTP 401' }).success).toBe(true)
    expect(CustomModelsLookupSchema.safeParse({ status: 'unavailable', error: '' }).success).toBe(false)
    expect(CustomModelsLookupSchema.safeParse({ status: 'unavailable' }).success).toBe(false)
  })
})

describe('CustomProviderCreateResponseSchema', () => {
  const provider = {
    name: 'lm-studio',
    enabled: false,
    api_base_url: 'http://localhost:1234/v1/chat/completions',
    api_key: 'lm-studio',
    auth_mode: 'api_key',
    api_style: 'openai_chat',
    models: ['qwen3']
  }

  test('warnings is always present, empty when there is nothing to say', () => {
    const ok = CustomProviderCreateResponseSchema.safeParse({
      success: true,
      provider,
      models: { status: 'found', count: 1 },
      warnings: []
    })
    expect(ok.success).toBe(true)
    const missing = CustomProviderCreateResponseSchema.safeParse({
      success: true,
      provider,
      models: { status: 'found', count: 1 }
    })
    expect(missing.success).toBe(false)
  })
})

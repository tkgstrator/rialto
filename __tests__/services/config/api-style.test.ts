/**
 * Which request shape a provider row and its models are stored with.
 *
 * For a catalog vendor the shape is a fact about the vendor and no payload
 * can move it. A custom provider has no vendor to derive it from: the
 * operator chose one of three formats, and it must survive every later
 * write, including the ones that never mention it.
 */
import { describe, expect, test } from 'bun:test'
import { ApiStyle } from '../../../src/generated/prisma/client'
import { apiStyleForVendor, modelApiStyleOverride, providerApiStyle } from '../../../src/services/config/api-style'

describe('providerApiStyle - catalog vendors', () => {
  test('the name decides, and a requested style cannot move it', () => {
    expect(providerApiStyle('openai', false, ApiStyle.anthropic, undefined)).toBe(ApiStyle.openai_chat)
    expect(providerApiStyle('anthropic', false, ApiStyle.openai_chat, ApiStyle.openai_chat)).toBe(ApiStyle.anthropic)
    expect(providerApiStyle('google', false, undefined, undefined)).toBe(ApiStyle.gemini)
  })
})

describe('providerApiStyle - custom providers', () => {
  test('the style the operator picked is stored, for each of the three formats', () => {
    expect(providerApiStyle('gw', true, ApiStyle.anthropic, undefined)).toBe(ApiStyle.anthropic)
    expect(providerApiStyle('gw', true, ApiStyle.openai_chat, undefined)).toBe(ApiStyle.openai_chat)
    expect(providerApiStyle('gw', true, ApiStyle.openai_responses, undefined)).toBe(ApiStyle.openai_responses)
  })

  test('a payload without a style keeps what the row holds', () => {
    expect(providerApiStyle('gw', true, undefined, ApiStyle.anthropic)).toBe(ApiStyle.anthropic)
    expect(providerApiStyle('gw', true, undefined, ApiStyle.openai_responses)).toBe(ApiStyle.openai_responses)
  })

  test('a requested style wins over the stored one, so the operator can change format', () => {
    expect(providerApiStyle('gw', true, ApiStyle.openai_responses, ApiStyle.anthropic)).toBe(ApiStyle.openai_responses)
  })

  test('gemini is not a style a custom endpoint can have, so it is not honoured', () => {
    expect(providerApiStyle('gw', true, ApiStyle.gemini, ApiStyle.anthropic)).toBe(ApiStyle.anthropic)
  })

  test('a row that does not exist yet and a payload with no style fall back to the name default', () => {
    expect(providerApiStyle('gw', true, undefined, undefined)).toBe(apiStyleForVendor('gw'))
    expect(apiStyleForVendor('gw')).toBe(ApiStyle.openai_chat)
  })
})

describe('modelApiStyleOverride', () => {
  test('a codex-family model of a catalog vendor is Responses-only', () => {
    expect(modelApiStyleOverride('gpt-5-codex')).toBe(ApiStyle.openai_responses)
    expect(modelApiStyleOverride('gpt-5-codex', false)).toBe(ApiStyle.openai_responses)
  })

  test('any other model of a catalog vendor inherits the provider style', () => {
    expect(modelApiStyleOverride('gpt-5-mini')).toBeNull()
  })

  test('a custom provider never derives an override from a model name', () => {
    expect(modelApiStyleOverride('gpt-5-codex', true)).toBeNull()
    expect(modelApiStyleOverride('qwen3-coder', true)).toBeNull()
  })
})

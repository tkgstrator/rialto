/**
 * `hostsWebSearch` decides on the same apiStyle the transformer chain is
 * built from, so the Routing badge and the tier router cannot disagree
 * with what actually runs.
 */

import { expect, test } from 'bun:test'
import { hostsWebSearch } from '../../src/shared/transformer-chain'

const provider = (
  auth_mode: 'api_key' | 'subscription',
  api_style: 'anthropic' | 'openai_chat' | 'openai_responses' | 'gemini' | undefined,
  api_base_url = 'https://example.test'
) => ({
  name: 'p',
  auth_mode,
  api_style,
  api_base_url
})

test('Anthropic, Responses and Gemini carry the tool across; Chat Completions does not', () => {
  expect(hostsWebSearch(provider('api_key', 'anthropic'), undefined)).toBe(true)
  expect(hostsWebSearch(provider('subscription', 'openai_responses'), undefined)).toBe(true)
  expect(hostsWebSearch(provider('api_key', 'gemini'), undefined)).toBe(true)
  expect(hostsWebSearch(provider('api_key', 'openai_chat'), undefined)).toBe(false)
})

test("an api_key provider's per-model override wins, as it does for the chain", () => {
  expect(hostsWebSearch(provider('api_key', 'openai_chat'), 'openai_responses')).toBe(true)
})

test('a subscription provider ignores per-model styles, as the chain does', () => {
  expect(hostsWebSearch(provider('subscription', 'anthropic'), 'openai_chat')).toBe(true)
})

test("a legacy subscription row's style is inferred from its base URL", () => {
  expect(hostsWebSearch(provider('subscription', undefined, 'https://chatgpt.com/backend-api/codex'), undefined)).toBe(
    true
  )
})

/**
 * Gemini's thinkingConfig as the unified reasoning block the converter
 * sends upstream.
 *
 * The budget is bucketed by the helper Anthropic's `thinking_budget` goes
 * through, which reads anything at or below 0 as "none". Gemini's -1 means
 * "dynamic": think, and let the model decide how much — so it has to be
 * caught before that helper, or a client asking to think gets thinking
 * switched off upstream.
 */

import { describe, expect, test } from 'bun:test'
import { inboundReasoning } from '../../../src/llms/utils/gemini/inbound-request'

describe('inboundReasoning', () => {
  test('a -1 budget is enabled, with no effort and no token cap', () => {
    expect(inboundReasoning({ thinkingConfig: { thinkingBudget: -1 } })).toEqual({ enabled: true })
  })

  test('a 0 budget is off', () => {
    expect(inboundReasoning({ thinkingConfig: { thinkingBudget: 0 } })).toEqual({
      enabled: false,
      effort: 'none',
      max_tokens: 0
    })
  })

  test('a positive budget is bucketed and passed on as the cap', () => {
    expect(inboundReasoning({ thinkingConfig: { thinkingBudget: 8_192 } })).toEqual({
      enabled: true,
      effort: 'medium',
      max_tokens: 8_192
    })
  })

  test('no thinkingConfig says nothing', () => {
    expect(inboundReasoning({})).toBeUndefined()
  })
})

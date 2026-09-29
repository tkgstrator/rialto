import { describe, expect, test } from 'bun:test'
import { fitThinkingOff } from '../../src/llms/pipeline/thinking-off'
import type { ResolvedProvider } from '../../src/llms/registry/provider'

// What the probe recorded for each model (ModelCapability).
const provider: ResolvedProvider = {
  name: 'claude-code',
  api_base_url: 'https://api.anthropic.com/v1/messages',
  api_key: 'oauth',
  models: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-unprobed'],
  modelThinkingOff: {
    'claude-sonnet-5-5': { disabled: [], betweenTools: ['default', 'low', 'medium', 'high'] },
    'claude-sonnet-5': { disabled: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], betweenTools: [] },
    'claude-opus-5-5': { disabled: [], betweenTools: [] }
  }
}

const off = (model: string, effort?: string): Record<string, unknown> => ({
  model,
  thinking: { type: 'disabled' },
  ...(effort === undefined ? {} : { output_config: { effort } })
})

describe('fitThinkingOff', () => {
  test('sends between_tools to a model that refuses disabled but takes it at this effort', () => {
    const body = off('claude-sonnet-5-5')
    expect(fitThinkingOff(body, provider)).toBe('between_tools')
    expect(body.thinking).toEqual({ type: 'between_tools' })
  })

  test('leaves thinking out where the model can switch it off no way at this effort', () => {
    const tooHigh = off('claude-sonnet-5-5', 'xhigh')
    expect(fitThinkingOff(tooHigh, provider)).toBe('dropped')
    expect(tooHigh).toEqual({ model: 'claude-sonnet-5-5', output_config: { effort: 'xhigh' } })
    const alwaysOn = off('claude-opus-5-5')
    expect(fitThinkingOff(alwaysOn, provider)).toBe('dropped')
    expect(alwaysOn).not.toHaveProperty('thinking')
  })

  test('keeps disabled on a model that takes it: the caller opted out and the model can honour that', () => {
    const body = off('claude-sonnet-5', 'max')
    expect(fitThinkingOff(body, provider)).toBeNull()
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  test('touches nothing it has no verdict for', () => {
    for (const body of [
      off('claude-unprobed'),
      off('claude-sonnet-5-5', 'turbo'),
      { model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' } },
      { model: 'claude-sonnet-5-5' }
    ]) {
      const before = structuredClone(body)
      expect(fitThinkingOff(body, provider)).toBeNull()
      expect(body).toEqual(before)
    }
  })
})

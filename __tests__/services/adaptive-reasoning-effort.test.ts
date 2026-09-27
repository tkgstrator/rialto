import { describe, expect, test } from 'bun:test'
import { effortForPace } from '../../src/services/adaptive-reasoning-effort'
import { openAiEffortsFor } from '../../src/shared/model-reasoning-effort'

describe('adaptive reasoning effort', () => {
  test('uses the target supported ladder and never chooses none', () => {
    const levels = openAiEffortsFor('gpt-5.4')
    expect(effortForPace(59.9, levels)).toBe('high')
    expect(effortForPace(60, levels)).toBe('medium')
    expect(effortForPace(100, levels)).toBe('medium')
    expect(effortForPace(100.1, levels)).toBe('low')
    expect(effortForPace(120, ['none', 'high'])).toBe('high')
    expect(effortForPace(30, ['none'])).toBeNull()
  })

  test('ignores unknown projections and unverified models', () => {
    expect(effortForPace(null, ['low'])).toBeNull()
    expect(effortForPace(Number.NaN, ['low'])).toBeNull()
    expect(effortForPace(-1, ['low'])).toBeNull()
    expect(effortForPace(25, null)).toBeNull()
    expect(openAiEffortsFor('gpt-5.5')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(openAiEffortsFor('gpt-5.1')).toEqual(['none', 'low', 'medium', 'high'])
    expect(openAiEffortsFor('gpt-5')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(openAiEffortsFor('gpt-5.4-mini')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(openAiEffortsFor('gpt-5.4-2026-08-01')).toBeNull()
    expect(openAiEffortsFor('gpt-5.4-mini-2026-08-01')).toBeNull()
    expect(openAiEffortsFor('gpt-5-mini')).toBeNull()
    expect(openAiEffortsFor('o3')).toBeNull()
    expect(openAiEffortsFor('gpt-5.6')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(openAiEffortsFor('gpt-5.6-terra')).toEqual(openAiEffortsFor('gpt-5.6'))
    expect(openAiEffortsFor('gpt-5.6-sol')).toEqual(openAiEffortsFor('gpt-5.6'))
    expect(openAiEffortsFor('gpt-5.6-luna')).toEqual(openAiEffortsFor('gpt-5.6'))
    expect(openAiEffortsFor('gpt-6-sol')).toEqual(openAiEffortsFor('gpt-5.6'))
    expect(openAiEffortsFor('gpt-6-luna')).toEqual(openAiEffortsFor('gpt-5.6'))
    expect(openAiEffortsFor('gpt-6-astra')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(openAiEffortsFor('gpt-6-astra-2026-01-01')).toBeNull()
  })
})

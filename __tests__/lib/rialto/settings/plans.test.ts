import { describe, expect, test } from 'bun:test'
import {
  capPct,
  emptyPlanDraft,
  groupTargets,
  modelOf,
  planDraftChanged,
  planDraftOf,
  planInputOf,
  providerOf,
  readCap,
  toggleModel
} from '../../../../src/lib/rialto/settings/plans'

const FREE = {
  name: 'Free',
  models: ['codex,gpt-6-luna', 'google,gemini-3-flash'],
  defaultModel: 'codex,gpt-6-luna',
  dailyRequestLimit: 100
}

describe('plan targets', () => {
  test('splits provider and model at the first comma', () => {
    expect(providerOf('codex,gpt-6-luna')).toBe('codex')
    expect(modelOf('openrouter,a,b')).toBe('a,b')
  })

  test('groups by provider and keeps a selected model that is no longer available', () => {
    const groups = groupTargets(['codex,gpt-6-luna', 'google,gemini-3-flash', 'codex,gpt-6-sol'], ['anthropic,old'])
    expect(groups).toEqual([
      { provider: 'codex', targets: ['codex,gpt-6-luna', 'codex,gpt-6-sol'] },
      { provider: 'google', targets: ['google,gemini-3-flash'] },
      { provider: 'anthropic', targets: ['anthropic,old'] }
    ])
  })
})

describe('plan draft', () => {
  test('the first model ticked becomes the default, and unticking it hands the default on', () => {
    const one = toggleModel(emptyPlanDraft(), 'codex,gpt-6-luna')
    expect(one.defaultModel).toBe('codex,gpt-6-luna')
    const two = toggleModel(one, 'codex,gpt-6-sol')
    expect(two.defaultModel).toBe('codex,gpt-6-luna')
    const back = toggleModel(two, 'codex,gpt-6-luna')
    expect(back).toMatchObject({ models: ['codex,gpt-6-sol'], defaultModel: 'codex,gpt-6-sol' })
    expect(toggleModel(back, 'codex,gpt-6-sol').defaultModel).toBe('')
  })

  test('reads the cap: empty is no cap, commas allowed, zero and fractions refused', () => {
    expect(readCap('')).toEqual({ ok: true, value: null })
    expect(readCap('1,000')).toEqual({ ok: true, value: 1000 })
    expect(readCap('0').ok).toBe(false)
    expect(readCap('1.5').ok).toBe(false)
  })

  test('builds the body only when the server would accept it', () => {
    expect(planInputOf(planDraftOf(FREE))).toEqual(FREE)
    expect(planInputOf({ ...planDraftOf(FREE), name: ' ' })).toBeNull()
    expect(planInputOf({ ...planDraftOf(FREE), models: [] })).toBeNull()
    expect(planInputOf({ ...planDraftOf(FREE), cap: 'x' })).toBeNull()
  })

  test('an untouched draft is not a change, a reordered list neither', () => {
    expect(planDraftChanged(planDraftOf(FREE), FREE)).toBe(false)
    const reordered = { ...planDraftOf(FREE), models: [...FREE.models].reverse() }
    expect(planDraftChanged(reordered, FREE)).toBe(false)
    expect(planDraftChanged({ ...planDraftOf(FREE), cap: '150' }, FREE)).toBe(true)
  })

  test('measures a device against its cap, and not at all without one', () => {
    expect(capPct(37, 100)).toBe(37)
    expect(capPct(140, 100)).toBe(100)
    expect(capPct(5, null)).toBeNull()
  })
})

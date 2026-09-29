import { describe, expect, test } from 'bun:test'
import {
  chooseDefault,
  clearModels,
  emptyPlanDraft,
  groupTargets,
  modelOf,
  planDraftChanged,
  planDraftOf,
  planInputOf,
  providerOf,
  providerSelection,
  readCap,
  readSpend,
  selectAllModels,
  toggleModel,
  toggleProvider
} from '../../../../src/lib/rialto/settings/plans'

const FREE = {
  name: 'Free',
  models: ['codex,gpt-6-luna', 'google,gemini-3-flash'],
  defaultModel: 'codex,gpt-6-luna',
  fiveHourRequestLimit: 100,
  fiveHourSpendLimitUsd: 2.5,
  sevenDayRequestLimit: null,
  sevenDaySpendLimitUsd: 20
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
  test('ticking never picks a default, and unticking the default clears it', () => {
    const one = toggleModel(emptyPlanDraft(), 'codex,gpt-6-luna')
    expect(one).toMatchObject({ models: ['codex,gpt-6-luna'], defaultModel: '' })
    expect(planInputOf({ ...one, name: 'Team' })).toBeNull()
    const chosen = chooseDefault(toggleModel(one, 'codex,gpt-6-sol'), 'codex,gpt-6-luna')
    expect(chosen.defaultModel).toBe('codex,gpt-6-luna')
    const back = toggleModel(chosen, 'codex,gpt-6-luna')
    expect(back).toMatchObject({ models: ['codex,gpt-6-sol'], defaultModel: '' })
    expect(toggleModel(back, 'codex,gpt-6-luna').defaultModel).toBe('')
  })

  test('a model that is not allowed cannot become the default', () => {
    expect(chooseDefault(planDraftOf(FREE), 'codex,gpt-6-sol').defaultModel).toBe('codex,gpt-6-luna')
  })

  test('reads the cap: empty is no cap, commas allowed, zero and fractions refused', () => {
    expect(readCap('')).toEqual({ ok: true, value: null })
    expect(readCap('1,000')).toEqual({ ok: true, value: 1000 })
    expect(readCap('0').ok).toBe(false)
    expect(readCap('1.5').ok).toBe(false)
  })

  test('reads a spend limit: empty is no limit, a dollar sign and cents allowed, zero refused', () => {
    expect(readSpend('')).toEqual({ ok: true, value: null })
    expect(readSpend('$2.50')).toEqual({ ok: true, value: 2.5 })
    expect(readSpend('1,000')).toEqual({ ok: true, value: 1000 })
    expect(readSpend('0').ok).toBe(false)
    expect(readSpend('-1').ok).toBe(false)
    expect(readSpend('abc').ok).toBe(false)
  })

  test('builds the body only when the server would accept it', () => {
    expect(planInputOf(planDraftOf(FREE))).toEqual(FREE)
    expect(planInputOf({ ...planDraftOf(FREE), name: ' ' })).toBeNull()
    expect(planInputOf({ ...planDraftOf(FREE), models: [] })).toBeNull()
    const draft = planDraftOf(FREE)
    expect(planInputOf({ ...draft, limits: { ...draft.limits, fiveHourRequestLimit: 'x' } })).toBeNull()
    expect(planInputOf({ ...draft, limits: { ...draft.limits, sevenDaySpendLimitUsd: '0' } })).toBeNull()
  })

  test('an untouched draft is not a change, a reordered list neither', () => {
    expect(planDraftChanged(planDraftOf(FREE), FREE)).toBe(false)
    const reordered = { ...planDraftOf(FREE), models: [...FREE.models].reverse() }
    expect(planDraftChanged(reordered, FREE)).toBe(false)
    const draft = planDraftOf(FREE)
    expect(planDraftChanged({ ...draft, limits: { ...draft.limits, sevenDayRequestLimit: '150' } }, FREE)).toBe(true)
    expect(planDraftChanged({ ...draft, limits: { ...draft.limits, fiveHourSpendLimitUsd: '2.50' } }, FREE)).toBe(false)
  })
})

// The mock's fixture catalogue: Codex 4, Google 2, Anthropic 3, OpenAI 2.
const CATALOG = [
  'codex,gpt-6-luna',
  'codex,gpt-5.6-terra',
  'codex,gpt-6-sol',
  'codex,gpt-6-astra',
  'google,gemini-3-flash',
  'google,gemini-3-pro',
  'anthropic,claude-haiku-4-5',
  'anthropic,claude-sonnet-5',
  'anthropic,claude-opus-5',
  'openai,gpt-6-luna',
  'openai,gpt-6-sol'
]

const counts = (draft: ReturnType<typeof planDraftOf>) =>
  groupTargets(CATALOG, draft.models).map(
    (group) => `${group.targets.filter((target) => draft.models.includes(target)).length}/${group.targets.length}`
  )

describe('bulk model selection', () => {
  const free = planDraftOf(FREE)
  const groups = groupTargets(CATALOG, free.models)
  const codex = groups[0]

  test('Select all allows all 11 and keeps the default (?edit&all)', () => {
    const all = selectAllModels(free, groups)
    expect(all.models).toHaveLength(11)
    expect(counts(all)).toEqual(['4/4', '2/2', '3/3', '2/2'])
    expect(providerSelection(all, codex)).toBe('all')
    expect(all.defaultModel).toBe('codex,gpt-6-luna')
    expect(planInputOf(all)).not.toBeNull()
  })

  test('Clear empties every provider and drops the default (?edit&none)', () => {
    const none = clearModels(free)
    expect(counts(none)).toEqual(['0/4', '0/2', '0/3', '0/2'])
    expect(providerSelection(none, codex)).toBe('none')
    expect(none.defaultModel).toBe('')
    expect(planInputOf(none)).toBeNull()
  })

  test('Select all after Clear still needs an explicit default (?edit&all&no-default)', () => {
    const all = selectAllModels(clearModels(free), groups)
    expect(counts(all)).toEqual(['4/4', '2/2', '3/3', '2/2'])
    expect(all.defaultModel).toBe('')
    expect(planInputOf(all)).toBeNull()
    expect(planInputOf(chooseDefault(all, 'google,gemini-3-pro'))).not.toBeNull()
  })

  test('the provider checkbox: mixed becomes all, all becomes none', () => {
    expect(providerSelection(free, codex)).toBe('some')
    const all = toggleProvider(free, codex)
    expect(providerSelection(all, codex)).toBe('all')
    expect(all.defaultModel).toBe('codex,gpt-6-luna')
    const none = toggleProvider(all, codex)
    expect(providerSelection(none, codex)).toBe('none')
  })

  test('clearing one provider keeps the others and does not hand the default on (?edit&provider-none)', () => {
    const cleared = toggleProvider(toggleProvider(free, codex), codex)
    expect(counts(cleared)).toEqual(['0/4', '1/2', '0/3', '0/2'])
    expect(cleared.models).toEqual(['google,gemini-3-flash'])
    expect(cleared.defaultModel).toBe('')
    expect(planInputOf(cleared)).toBeNull()
  })

  test('a new plan cleared and selected (?create&none, ?create&all)', () => {
    const blank = { ...emptyPlanDraft(), name: 'Team' }
    expect(planInputOf(clearModels(blank))).toBeNull()
    const all = selectAllModels(blank, groupTargets(CATALOG, []))
    expect(all.models).toHaveLength(11)
    expect(all.defaultModel).toBe('')
  })
})

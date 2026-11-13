/**
 * What a provider page's Save writes.
 *
 * The page reads until Edit is pressed and holds every change in a draft
 * until Save, which writes only what differs from the provider as loaded.
 * Two rules are pinned here because the screen cannot show them going
 * wrong: a change made and then undone by hand writes nothing, and efforts
 * go as their own writes rather than riding on the provider upsert, which
 * does not store them.
 */
import { describe, expect, test } from 'bun:test'
import { disabledModelsOf, effortOf } from '../../../src/components/rialto/providers/derive'
import { applyDraft, EMPTY_DRAFT, hasChanges, savePlan } from '../../../src/components/rialto/providers/provider-draft'
import type { Provider } from '../../../src/components/rialto/providers/types'

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  name: 'openai',
  enabled: true,
  api_base_url: 'https://api.openai.com/v1',
  api_key: 'sk-old',
  auth_mode: 'api_key',
  models: ['gpt-5', 'gpt-4.1', 'o3'],
  modelReasoningEfforts: { o3: 'high' },
  transformer: { _disabledModels: ['o3'] },
  ...overrides
})

describe('applyDraft', () => {
  test('renders every staged change', () => {
    const shown = applyDraft(provider(), {
      ...EMPTY_DRAFT,
      enabled: false,
      models: { o3: true, 'gpt-4.1': false },
      efforts: { o3: null, 'gpt-5': 'low' },
      apiKey: 'sk-new'
    })
    expect(shown.enabled).toBe(false)
    expect(disabledModelsOf(shown)).toEqual(['gpt-4.1'])
    expect(effortOf(shown, 'o3')).toBeNull()
    expect(effortOf(shown, 'gpt-5')).toBe('low')
    expect(shown.api_key).toBe('sk-new')
  })

  test('keeps an Auto effort in the draft and sends it as its own write', () => {
    const draft = { ...EMPTY_DRAFT, efforts: { 'gpt-5': 'auto' as const } }
    expect(effortOf(applyDraft(provider(), draft), 'gpt-5')).toBe('auto')
    expect(savePlan(provider(), draft).efforts).toEqual([{ model: 'gpt-5', effort: 'auto' }])
  })

  test('an empty key clears the stored one', () => {
    expect(applyDraft(provider(), { ...EMPTY_DRAFT, apiKey: '' }).api_key).toBeNull()
  })
})

describe('savePlan', () => {
  test('nothing staged writes nothing', () => {
    const plan = savePlan(provider(), EMPTY_DRAFT)
    expect(plan).toEqual({ upsert: null, efforts: [] })
    expect(hasChanges(plan)).toBe(false)
  })

  test('a change made and undone by hand writes nothing', () => {
    // Every value below is the one already stored: o3 is off and gpt-5 on,
    // o3's effort is high and gpt-5 has none, and the provider is on.
    const plan = savePlan(provider(), {
      ...EMPTY_DRAFT,
      enabled: true,
      models: { o3: false, 'gpt-5': true },
      efforts: { o3: 'high', 'gpt-5': null }
    })
    expect(hasChanges(plan)).toBe(false)
  })

  test('switches and the key go in one upsert of the loaded row; efforts only as their own writes', () => {
    const loaded = provider()
    const plan = savePlan(loaded, {
      ...EMPTY_DRAFT,
      models: { o3: true },
      efforts: { 'gpt-5': 'low' },
      apiKey: 'sk-new'
    })
    const upsert = plan.upsert
    if (upsert === null) throw new Error('expected an upsert')
    expect(upsert.api_key).toBe('sk-new')
    expect(disabledModelsOf(upsert)).toEqual([])
    // Carried as loaded, not as drafted: the upsert does not store them.
    expect(upsert.modelReasoningEfforts).toEqual(loaded.modelReasoningEfforts)
    expect(plan.efforts).toEqual([{ model: 'gpt-5', effort: 'low' }])
  })

  test('flipping the provider switch is an upsert', () => {
    const plan = savePlan(provider(), { ...EMPTY_DRAFT, enabled: false })
    expect(plan.upsert === null ? null : plan.upsert.enabled).toBe(false)
  })
})

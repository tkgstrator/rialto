/**
 * What a provider page's Save writes.
 *
 * The page reads until Edit is pressed and holds every change in a draft
 * until Save, which writes only what differs from the provider as loaded.
 * Three rules are pinned here because the screen cannot show them going
 * wrong: a change made and then undone by hand writes nothing; aliases
 * and efforts go as their own writes rather than riding on the provider
 * upsert, which does not store them; and a model an alias is newly
 * pointed at reads as switched on, because the alias write switches it on.
 */
import { describe, expect, test } from 'bun:test'
import { disabledModelsOf, effortOf } from '../../../src/components/rialto/providers/derive'
import { applyDraft, EMPTY_DRAFT, hasChanges, savePlan } from '../../../src/components/rialto/providers/provider-draft'
import type { AliasMap } from '../../../src/components/rialto/providers/tier-aliases'
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

// gpt-5 answers for opus; sonnet and the rest are unset.
const STORED: AliasMap = { opus: 'gpt-5' }

describe('applyDraft', () => {
  test('renders every staged change', () => {
    const shown = applyDraft(
      provider(),
      {
        enabled: false,
        models: { o3: true, 'gpt-4.1': false },
        efforts: { o3: null, 'gpt-5': 'low' },
        aliases: {},
        apiKey: 'sk-new'
      },
      STORED
    )
    expect(shown.enabled).toBe(false)
    expect(disabledModelsOf(shown)).toEqual(['gpt-4.1'])
    expect(effortOf(shown, 'o3')).toBeNull()
    expect(effortOf(shown, 'gpt-5')).toBe('low')
    expect(shown.api_key).toBe('sk-new')
  })

  test('an empty key clears the stored one', () => {
    expect(applyDraft(provider(), { ...EMPTY_DRAFT, apiKey: '' }, STORED).api_key).toBeNull()
  })

  test('a model an alias is newly pointed at reads as switched on', () => {
    // o3 is off as loaded; promoting it is what switches it on.
    const shown = applyDraft(provider(), { ...EMPTY_DRAFT, aliases: { sonnet: 'o3' } }, STORED)
    expect(disabledModelsOf(shown)).toEqual([])
  })

  test('a pick equal to the stored alias switches nothing on', () => {
    // o3 is the stored sonnet alias but switched off; picking it again
    // writes nothing, so nothing turns it back on.
    const shown = applyDraft(provider(), { ...EMPTY_DRAFT, aliases: { sonnet: 'o3' } }, { sonnet: 'o3' })
    expect(disabledModelsOf(shown)).toEqual(['o3'])
  })

  test('unsetting an alias leaves its model switched as it was', () => {
    const shown = applyDraft(provider(), { ...EMPTY_DRAFT, aliases: { opus: null } }, STORED)
    expect(disabledModelsOf(shown)).toEqual(['o3'])
  })
})

describe('savePlan', () => {
  test('nothing staged writes nothing', () => {
    const plan = savePlan(provider(), EMPTY_DRAFT, STORED)
    expect(plan).toEqual({ upsert: null, aliases: [], efforts: [] })
    expect(hasChanges(plan)).toBe(false)
  })

  test('a change made and undone by hand writes nothing', () => {
    // Every value below is the one already stored: o3 is off and gpt-5 on,
    // opus names gpt-5 and sonnet nothing, o3's effort is high and gpt-5
    // has none, and the provider is on.
    const plan = savePlan(
      provider(),
      {
        enabled: true,
        models: { o3: false, 'gpt-5': true },
        efforts: { o3: 'high', 'gpt-5': null },
        aliases: { opus: 'gpt-5', sonnet: null }
      },
      STORED
    )
    expect(hasChanges(plan)).toBe(false)
  })

  test('switches and the key go in one upsert of the loaded row; aliases and efforts only as their own writes', () => {
    const loaded = provider()
    const plan = savePlan(
      loaded,
      {
        models: { o3: true },
        efforts: { 'gpt-5': 'low' },
        aliases: { sonnet: 'gpt-4.1' },
        apiKey: 'sk-new'
      },
      STORED
    )
    const upsert = plan.upsert
    if (upsert === null) throw new Error('expected an upsert')
    expect(upsert.api_key).toBe('sk-new')
    expect(disabledModelsOf(upsert)).toEqual([])
    // Carried as loaded, not as drafted: the upsert does not store them.
    expect(upsert.modelReasoningEfforts).toEqual(loaded.modelReasoningEfforts)
    expect(plan.aliases).toEqual([{ tier: 'sonnet', model: 'gpt-4.1' }])
    expect(plan.efforts).toEqual([{ model: 'gpt-5', effort: 'low' }])
  })

  test('promoting a switched-off model alone is one alias write, not an upsert too', () => {
    // The alias write switches o3 on itself; an upsert carrying the same
    // switch would be a second write for one change.
    expect(savePlan(provider(), { ...EMPTY_DRAFT, aliases: { sonnet: 'o3' } }, STORED)).toEqual({
      upsert: null,
      aliases: [{ tier: 'sonnet', model: 'o3' }],
      efforts: []
    })
  })

  test('unsetting an alias is a write naming no model', () => {
    const plan = savePlan(provider(), { ...EMPTY_DRAFT, aliases: { opus: null } }, STORED)
    expect(plan.aliases).toEqual([{ tier: 'opus', model: null }])
    expect(hasChanges(plan)).toBe(true)
  })

  test('alias writes come in strip order, whatever order they were picked in', () => {
    const plan = savePlan(provider(), { ...EMPTY_DRAFT, aliases: { haiku: 'o3', fable: 'gpt-4.1' } }, STORED)
    expect(plan.aliases.map((change) => change.tier)).toEqual(['fable', 'haiku'])
  })

  test('flipping the provider switch is an upsert', () => {
    const plan = savePlan(provider(), { ...EMPTY_DRAFT, enabled: false }, STORED)
    expect(plan.upsert === null ? null : plan.upsert.enabled).toBe(false)
  })
})

/**
 * Which model rows a provider's page shows.
 *
 * The demo data has no provider whose configured models overlap a
 * vendor's legacy price sheet, so this behaviour cannot be seen on a dev
 * install — which is exactly why it is pinned here.
 *
 * Two rules, and the second is the one that matters: legacy rows fold
 * away because they are a decision already made, but an ENABLED legacy
 * model is a live routing target and must stay visible. A list that hides
 * a live target cannot be trusted to say what the provider serves.
 */
import { describe, expect, test } from 'bun:test'
import { hidesAsLegacy, type ModelRow, passesShow } from '../../../src/components/rialto/providers/derive'

const row = (overrides: Partial<ModelRow>): ModelRow => ({
  name: 'gpt-4.1',
  tier: null,
  tierSource: 'unset',
  effort: null,
  contextWindow: undefined,
  inputPer1M: null,
  cachedInputPer1M: null,
  outputPer1M: null,
  apiStyleOverride: null,
  test: 'unknown',
  enabled: false,
  legacy: false,
  ...overrides
})

describe('hidesAsLegacy', () => {
  test('folds away a legacy model nobody switched on', () => {
    expect(hidesAsLegacy(row({ legacy: true, enabled: false }))).toBe(true)
  })

  test('keeps a legacy model that is enabled — it is a live target', () => {
    expect(hidesAsLegacy(row({ legacy: true, enabled: true }))).toBe(false)
  })

  test('leaves a current model alone whether it is on or off', () => {
    expect(hidesAsLegacy(row({ legacy: false, enabled: false }))).toBe(false)
    expect(hidesAsLegacy(row({ legacy: false, enabled: true }))).toBe(false)
  })
})

describe('passesShow', () => {
  test('a priced legacy row no longer survives the default view', () => {
    // The exact case the filter exists for: legacy models carry prices,
    // so "enabled or priced" used to admit every one of them.
    const legacyPriced = row({ legacy: true, inputPer1M: 2, outputPer1M: 8 })
    expect(passesShow(legacyPriced, 'priced')).toBe(false)
    expect(passesShow(legacyPriced, 'enabled')).toBe(false)
  })

  test('All models is where a folded-away row is reachable again', () => {
    expect(passesShow(row({ legacy: true, inputPer1M: 2 }), 'all')).toBe(true)
  })

  test('an enabled legacy row shows in every mode', () => {
    const live = row({ legacy: true, enabled: true })
    expect(passesShow(live, 'priced')).toBe(true)
    expect(passesShow(live, 'enabled')).toBe(true)
    expect(passesShow(live, 'all')).toBe(true)
  })

  test('the pre-existing rules still hold for current models', () => {
    expect(passesShow(row({ enabled: true }), 'enabled')).toBe(true)
    expect(passesShow(row({ enabled: false }), 'enabled')).toBe(false)
    // Priced but off: the price is why it is worth offering.
    expect(passesShow(row({ enabled: false, outputPer1M: 8 }), 'priced')).toBe(true)
    // Neither on nor priced: nothing to say about it.
    expect(passesShow(row({ enabled: false }), 'priced')).toBe(false)
  })
})

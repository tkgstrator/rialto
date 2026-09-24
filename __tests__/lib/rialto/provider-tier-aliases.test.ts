/**
 * What a provider page's tier-alias strip shows and offers.
 *
 * The strip is the one place a new model release is taken up, so two
 * things are pinned here that a screen would only show going wrong on a
 * vendor that happens to have shipped something: a newer model is marked
 * without moving the alias, and a picker offers every model on the
 * provider — Codex and an OpenAI key name no Claude family, and offering
 * the tier's name-matched candidates alone would leave them nothing.
 */
import { describe, expect, test } from 'bun:test'
import { buildModelRows } from '../../../src/components/rialto/providers/derive'
import {
  aliasMapOf,
  aliasOptions,
  aliasRowsOf,
  applyAliasPicks,
  freshModelsOf,
  newCountOf,
  tiersServedBy
} from '../../../src/components/rialto/providers/tier-aliases'
import type { Provider, TierAliasWire } from '../../../src/components/rialto/providers/types'

const alias = (overrides: Partial<TierAliasWire> & Pick<TierAliasWire, 'tier'>): TierAliasWire => ({
  provider: 'claude-code',
  model: null,
  updatedAt: null,
  candidates: [],
  ...overrides
})

// Opus has a newer candidate than the one it names; sonnet serves the
// same model as haiku; fable is unset.
const ROWS: TierAliasWire[] = [
  alias({ tier: 'fable' }),
  alias({
    tier: 'opus',
    model: 'claude-opus-4-8',
    updatedAt: '2026-09-01T00:00:00.000Z',
    candidates: [
      { model: 'claude-opus-4-7', enabled: true, isNew: false },
      { model: 'claude-opus-5', enabled: false, isNew: true }
    ]
  }),
  alias({ tier: 'sonnet', model: 'claude-sonnet-5', updatedAt: '2026-09-01T00:00:00.000Z' }),
  alias({ tier: 'haiku', model: 'claude-sonnet-5', updatedAt: '2026-09-01T00:00:00.000Z' }),
  alias({ provider: 'codex', tier: 'opus', model: 'gpt-5.5', updatedAt: '2026-09-01T00:00:00.000Z' })
]

const LISTED = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-4-5']

describe('aliasMapOf', () => {
  test("reads one provider's set tiers, leaving unset ones out", () => {
    expect(aliasMapOf(aliasRowsOf(ROWS, 'claude-code'))).toEqual({
      opus: 'claude-opus-4-8',
      sonnet: 'claude-sonnet-5',
      haiku: 'claude-sonnet-5'
    })
  })
})

describe('applyAliasPicks', () => {
  test('lays picks over the stored aliases; null unsets', () => {
    const stored = aliasMapOf(aliasRowsOf(ROWS, 'claude-code'))
    expect(applyAliasPicks(stored, { opus: 'claude-opus-5', haiku: null, fable: 'claude-opus-4-7' })).toEqual({
      fable: 'claude-opus-4-7',
      opus: 'claude-opus-5',
      sonnet: 'claude-sonnet-5'
    })
  })
})

describe('new candidates', () => {
  test('are counted per tier and marked per model, without moving the alias', () => {
    const rows = aliasRowsOf(ROWS, 'claude-code')
    expect(newCountOf(rows.find((row) => row.tier === 'opus'))).toBe(1)
    expect(newCountOf(rows.find((row) => row.tier === 'sonnet'))).toBe(0)
    expect([...freshModelsOf(rows)]).toEqual(['claude-opus-5'])
    expect(aliasMapOf(rows).opus).toBe('claude-opus-4-8')
  })
})

describe('aliasOptions', () => {
  test('offers the stored model, then candidates new first, then every other listed model', () => {
    const opus = ROWS.find((row) => row.provider === 'claude-code' && row.tier === 'opus')
    expect(aliasOptions(opus, LISTED)).toEqual({
      current: 'claude-opus-4-8',
      candidates: [
        { model: 'claude-opus-5', isNew: true },
        { model: 'claude-opus-4-7', isNew: false }
      ],
      others: ['claude-sonnet-5', 'claude-haiku-4-5']
    })
  })

  test('a provider whose names say no tier still offers every listed model', () => {
    const codex = ROWS.find((row) => row.provider === 'codex')
    expect(aliasOptions(codex, ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'])).toEqual({
      current: 'gpt-5.5',
      candidates: [],
      others: ['gpt-5.3-codex', 'gpt-5.3-codex-spark']
    })
  })

  test('an unset tier with no rows loaded still offers the listed models', () => {
    expect(aliasOptions(undefined, ['a', 'b'])).toEqual({ current: null, candidates: [], others: ['a', 'b'] })
  })
})

describe('the Alias column', () => {
  const provider: Provider = {
    name: 'claude-code',
    enabled: true,
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: null,
    auth_mode: 'subscription',
    models: LISTED
  }

  test('names every tier a model serves, in strip order', () => {
    const aliases = aliasMapOf(aliasRowsOf(ROWS, 'claude-code'))
    expect(tiersServedBy(aliases, 'claude-sonnet-5')).toEqual(['sonnet', 'haiku'])
    expect(tiersServedBy(aliases, 'claude-opus-4-7')).toEqual([])
  })

  test('rows carry the tiers served and the new mark', () => {
    const rows = aliasRowsOf(ROWS, 'claude-code')
    const byName = new Map(
      buildModelRows(provider, undefined, aliasMapOf(rows), freshModelsOf(rows)).map((row) => [row.name, row])
    )
    expect(byName.get('claude-sonnet-5')?.aliasTiers).toEqual(['sonnet', 'haiku'])
    expect(byName.get('claude-opus-5')?.isNew).toBe(true)
    expect(byName.get('claude-opus-4-8')?.isNew).toBe(false)
  })

  test('the add-provider wizard, which loads no aliases, reads every row as serving nothing', () => {
    expect(buildModelRows(provider, undefined).every((row) => row.aliasTiers.length === 0 && !row.isNew)).toBe(true)
  })
})

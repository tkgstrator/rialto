/**
 * What a provider page's tier strip shows and offers.
 *
 * Pinned without a browser: a tier some model names follows the newest
 * switched-on one, so a switch staged in the table already moves it in the
 * preview; a newer switched-off model is counted and marked without
 * moving anything; only a manual tier (no model names it — Codex, an
 * OpenAI key) takes an alias, and its picker offers every listed model.
 */
import { describe, expect, test } from 'bun:test'
import { buildModelRows } from '../../../src/components/rialto/providers/derive'
import {
  aliasMapOf,
  aliasOptions,
  aliasRowsOf,
  applyAliasPicks,
  tierViewsOf
} from '../../../src/components/rialto/providers/tier-aliases'
import type { Provider, TierAliasWire } from '../../../src/components/rialto/providers/types'

const alias = (overrides: Partial<TierAliasWire> & Pick<TierAliasWire, 'tier'>): TierAliasWire => ({
  provider: 'codex',
  mode: 'manual',
  model: null,
  modelEnabled: false,
  updatedAt: null,
  candidates: [],
  ...overrides
})

const claudeCode = (models: string[], off: string[] = []): Provider => ({
  name: 'claude-code',
  enabled: true,
  api_base_url: 'https://api.anthropic.com/v1/messages',
  api_key: null,
  auth_mode: 'subscription',
  models,
  ...(off.length > 0 ? { transformer: { _disabledModels: off } } : {})
})

const codex = (models: string[]): Provider => ({
  name: 'codex',
  enabled: true,
  api_base_url: 'https://chatgpt.com/backend-api/codex',
  api_key: null,
  auth_mode: 'subscription',
  models
})

const CLAUDE = claudeCode(
  ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-4-5'],
  ['claude-opus-5', 'claude-haiku-4-5']
)

describe('aliasMapOf', () => {
  test("reads one provider's manual aliases, leaving unset and derived tiers out", () => {
    const rows: TierAliasWire[] = [
      alias({ tier: 'fable' }),
      alias({ tier: 'opus', model: 'gpt-5.5', modelEnabled: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
      alias({ provider: 'claude-code', tier: 'sonnet', mode: 'derived', model: 'claude-sonnet-5', modelEnabled: true })
    ]
    expect(aliasMapOf(aliasRowsOf(rows, 'codex'))).toEqual({ opus: 'gpt-5.5' })
    expect(aliasMapOf(aliasRowsOf(rows, 'claude-code'))).toEqual({})
  })
})

describe('applyAliasPicks', () => {
  test('lays picks over the stored aliases; null unsets', () => {
    expect(
      applyAliasPicks({ opus: 'gpt-5.5', haiku: 'gpt-5.4-mini' }, { opus: 'gpt-5.4', haiku: null, fable: 'gpt-5.5' })
    ).toEqual({ fable: 'gpt-5.5', opus: 'gpt-5.4' })
  })
})

describe('tierViewsOf', () => {
  test('a named tier follows the newest switched-on model and counts the newer ones that are off', () => {
    const views = tierViewsOf(CLAUDE, {})
    expect(views.find((v) => v.tier === 'opus')).toEqual({
      tier: 'opus',
      mode: 'derived',
      model: 'claude-opus-4-8',
      enabled: true,
      named: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
      newer: ['claude-opus-5']
    })
  })

  test('a switch staged in the table moves the tier in the preview', () => {
    const switched = claudeCode(CLAUDE.models, ['claude-haiku-4-5'])
    expect(tierViewsOf(switched, {}).find((v) => v.tier === 'opus')).toMatchObject({
      model: 'claude-opus-5',
      newer: []
    })
  })

  test('with every named model off, the tier reads as the newest one, switched off', () => {
    expect(tierViewsOf(CLAUDE, {}).find((v) => v.tier === 'haiku')).toMatchObject({
      mode: 'derived',
      model: 'claude-haiku-4-5',
      enabled: false
    })
  })

  test('a tier no model names is manual: the alias, or unset', () => {
    const views = tierViewsOf(codex(['gpt-5.5', 'gpt-5.4']), { sonnet: 'gpt-5.4' })
    expect(views.find((v) => v.tier === 'sonnet')).toEqual({
      tier: 'sonnet',
      mode: 'manual',
      model: 'gpt-5.4',
      enabled: true,
      named: [],
      newer: []
    })
    expect(views.find((v) => v.tier === 'fable')).toMatchObject({ mode: 'manual', model: null })
  })
})

describe('aliasOptions', () => {
  test('offers the stored model, then every other listed model', () => {
    expect(aliasOptions('gpt-5.5', ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'])).toEqual({
      current: 'gpt-5.5',
      others: ['gpt-5.3-codex', 'gpt-5.3-codex-spark']
    })
  })

  test('an unset tier still offers the listed models', () => {
    expect(aliasOptions(null, ['a', 'b'])).toEqual({ current: null, others: ['a', 'b'] })
  })
})

describe('the Tier column', () => {
  test('every named model carries its tier, routed only where the tier reaches it', () => {
    const byName = new Map(buildModelRows(CLAUDE, undefined, tierViewsOf(CLAUDE, {})).map((row) => [row.name, row]))
    expect(byName.get('claude-opus-4-8')?.tiers).toEqual([{ tier: 'opus', routed: true }])
    expect(byName.get('claude-opus-4-7')?.tiers).toEqual([{ tier: 'opus', routed: false }])
    expect(byName.get('claude-opus-5')?.tiers).toEqual([{ tier: 'opus', routed: false }])
    expect(byName.get('claude-opus-5')?.newer).toBe(true)
    expect(byName.get('claude-opus-4-8')?.newer).toBe(false)
  })

  test('a model a manual alias names serves every tier it is aliased as, in strip order', () => {
    const p = codex(['gpt-5.5', 'gpt-5.3-codex'])
    const rows = buildModelRows(p, undefined, tierViewsOf(p, { opus: 'gpt-5.5', sonnet: 'gpt-5.5' }))
    expect(rows.find((row) => row.name === 'gpt-5.5')?.tiers).toEqual([
      { tier: 'opus', routed: true },
      { tier: 'sonnet', routed: true }
    ])
    expect(rows.find((row) => row.name === 'gpt-5.3-codex')?.tiers).toEqual([])
  })

  test('the add-provider wizard, which resolves no tiers, reads every row as in none', () => {
    expect(buildModelRows(CLAUDE, undefined).every((row) => row.tiers.length === 0 && !row.newer)).toBe(true)
  })
})

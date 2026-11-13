/**
 * What the Routing screen's scenario table derives and edits.
 *
 * Every edit is a pure step from one draft to the next — add, change,
 * remove, move, switch — and so are what the add dialog offers for a
 * provider and how the Long context row states its threshold, so each is
 * pinned here rather than through the rendered table.
 */

import { describe, expect, test } from 'bun:test'
import {
  addCombination,
  cellOf,
  changeCombination,
  draftDiffers,
  draftOf,
  emptyDraft,
  formatThreshold,
  hasCombination,
  moveCombination,
  removeCombination,
  tierOptions,
  toggleCombination
} from '../../src/components/rialto/routing/derive'
import type { CellAddress, Combination, ScenarioDraft } from '../../src/components/rialto/routing/types'
import type { RoutingConstraintsWire, TierAliasWire, TierProfileViewWire } from '../../src/lib/api-types'

const line = (provider: string, targetTier: Combination['targetTier'], enabled = true): Combination => ({
  provider,
  targetTier,
  enabled
})

const constraints: RoutingConstraintsWire = {
  blockedEscalationTiers: [],
  exhaustedBehavior: '429',
  quotaSkipPct: 100,
  errorRateSkipPct: 0.5,
  minHealthSamples: 5,
  longContextThreshold: null,
  previousLongContextThreshold: null,
  longContextTunedAt: null,
  autoTuneLongContext: true
}

const resolved = { model: 'claude-sonnet-5', targetEnabled: true, hostsWebSearch: true, contextWindow: 1_000_000 }

const view: TierProfileViewWire = {
  key: 'live',
  routes: {
    default: {
      agent: [
        { ...line('claude-code', 'sonnet'), resolved },
        { ...line('codex', 'sonnet', false), resolved: null }
      ],
      subagent: [{ ...line('claude-code', 'haiku'), resolved: null }]
    },
    think: { agent: [{ ...line('claude-code', 'opus'), resolved: null }], subagent: [] },
    longContext: { agent: [], subagent: [] }
  },
  constraints,
  longContextThreshold: 700_000
}

const DEFAULT_AGENT: CellAddress = { scenario: 'default', lane: 'agent' }
const THINK_SUBAGENT: CellAddress = { scenario: 'think', lane: 'subagent' }

const providers = (draft: ScenarioDraft, at: CellAddress): string[] =>
  cellOf(draft, at).map((r) => `${r.provider}·${r.targetTier}`)

describe('draftOf / draftDiffers', () => {
  test('the draft carries every cell as a PUT writes it, without the resolution', () => {
    const draft = draftOf(view)
    expect(draft.default.agent).toEqual([line('claude-code', 'sonnet'), line('codex', 'sonnet', false)])
    expect(draft.default.agent[0]).not.toHaveProperty('resolved')
    expect(draft.think.agent).toEqual([line('claude-code', 'opus')])
    expect(draft.longContext).toEqual({ agent: [], subagent: [] })
  })

  test('the draft holds routes only; the constraints are not the editor’s', () => {
    expect(Object.keys(draftOf(view))).toEqual(['default', 'think', 'longContext'])
  })

  test('a draft read twice from the same profile is not a change', () => {
    expect(draftDiffers(draftOf(view), draftOf(view))).toBe(false)
  })

  test('an edit is a change, and undoing it by hand is not', () => {
    const base = draftOf(view)
    const off = toggleCombination(base, DEFAULT_AGENT, 0, false)
    expect(draftDiffers(off, base)).toBe(true)
    expect(draftDiffers(toggleCombination(off, DEFAULT_AGENT, 0, true), base)).toBe(false)
  })
})

describe('adding', () => {
  test('appends to the one cell, switched on, and leaves every other cell as it was', () => {
    const base = draftOf(view)
    const next = addCombination(base, THINK_SUBAGENT, 'codex', 'opus')
    expect(next.think.subagent).toEqual([line('codex', 'opus')])
    expect(next.think.agent).toBe(base.think.agent)
    expect(next.default).toBe(base.default)
  })

  test('refuses a provider · tier the cell already holds, but not one another cell holds', () => {
    const base = draftOf(view)
    expect(addCombination(base, DEFAULT_AGENT, 'codex', 'sonnet')).toBe(base)
    expect(providers(addCombination(base, THINK_SUBAGENT, 'claude-code', 'opus'), THINK_SUBAGENT)).toEqual([
      'claude-code·opus'
    ])
  })

  test('the same provider on another tier is another combination', () => {
    const next = addCombination(draftOf(view), DEFAULT_AGENT, 'claude-code', 'opus')
    expect(providers(next, DEFAULT_AGENT)).toEqual(['claude-code·sonnet', 'codex·sonnet', 'claude-code·opus'])
  })
})

describe('changing', () => {
  test('repoints the line in place and keeps its switch', () => {
    const next = changeCombination(draftOf(view), DEFAULT_AGENT, 1, 'openai', 'opus')
    expect(cellOf(next, DEFAULT_AGENT)).toEqual([line('claude-code', 'sonnet'), line('openai', 'opus', false)])
  })

  test('a line may keep what it already is', () => {
    const base = draftOf(view)
    expect(cellOf(changeCombination(base, DEFAULT_AGENT, 0, 'claude-code', 'sonnet'), DEFAULT_AGENT)).toEqual(
      cellOf(base, DEFAULT_AGENT)
    )
  })

  test('refuses to duplicate another line of the cell, and an index off the end', () => {
    const base = draftOf(view)
    expect(changeCombination(base, DEFAULT_AGENT, 1, 'claude-code', 'sonnet')).toBe(base)
    expect(changeCombination(base, DEFAULT_AGENT, 5, 'openai', 'opus')).toBe(base)
  })
})

describe('removing, switching, moving', () => {
  test('remove drops the one line', () => {
    expect(providers(removeCombination(draftOf(view), DEFAULT_AGENT, 0), DEFAULT_AGENT)).toEqual(['codex·sonnet'])
  })

  test('switching a line off keeps its place', () => {
    expect(cellOf(toggleCombination(draftOf(view), DEFAULT_AGENT, 0, false), DEFAULT_AGENT)).toEqual([
      line('claude-code', 'sonnet', false),
      line('codex', 'sonnet', false)
    ])
  })

  test('move reorders within the cell', () => {
    const base = addCombination(draftOf(view), DEFAULT_AGENT, 'openai', 'haiku')
    expect(providers(moveCombination(base, DEFAULT_AGENT, 2, 0), DEFAULT_AGENT)).toEqual([
      'openai·haiku',
      'claude-code·sonnet',
      'codex·sonnet'
    ])
    expect(providers(moveCombination(base, DEFAULT_AGENT, 0, 1), DEFAULT_AGENT)).toEqual([
      'codex·sonnet',
      'claude-code·sonnet',
      'openai·haiku'
    ])
  })

  test('a move, removal or switch off either end leaves the draft as it was', () => {
    const base = draftOf(view)
    expect(moveCombination(base, DEFAULT_AGENT, 0, -1)).toBe(base)
    expect(moveCombination(base, DEFAULT_AGENT, 1, 2)).toBe(base)
    expect(moveCombination(base, DEFAULT_AGENT, 0, 0)).toBe(base)
    expect(removeCombination(base, DEFAULT_AGENT, 2)).toBe(base)
    expect(toggleCombination(base, DEFAULT_AGENT, -1, false)).toBe(base)
  })

  test('the edits do not mutate the draft they were applied to', () => {
    const base = draftOf(view)
    const before = JSON.stringify(base)
    addCombination(base, DEFAULT_AGENT, 'openai', 'haiku')
    changeCombination(base, DEFAULT_AGENT, 0, 'openai', 'opus')
    removeCombination(base, DEFAULT_AGENT, 0)
    toggleCombination(base, DEFAULT_AGENT, 0, false)
    moveCombination(base, DEFAULT_AGENT, 0, 1)
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('hasCombination', () => {
  const routes = [line('claude-code', 'sonnet'), line('codex', 'opus')]

  test('is the same provider and the same tier', () => {
    expect(hasCombination(routes, 'claude-code', 'sonnet')).toBe(true)
    expect(hasCombination(routes, 'claude-code', 'opus')).toBe(false)
  })

  test('does not count the line being changed', () => {
    expect(hasCombination(routes, 'claude-code', 'sonnet', 0)).toBe(false)
    expect(hasCombination(routes, 'claude-code', 'sonnet', 1)).toBe(true)
  })
})

describe('tierOptions', () => {
  const alias = (provider: string, tier: TierAliasWire['tier'], model: string | null): TierAliasWire => ({
    provider,
    tier,
    model,
    updatedAt: null,
    candidates: []
  })
  const aliases = [
    alias('codex', 'opus', 'gpt-5.5'),
    alias('codex', 'sonnet', 'gpt-5.5-mini'),
    alias('codex', 'haiku', null),
    alias('claude-code', 'fable', 'claude-fable-1')
  ]

  test('all four tiers, most capable first; one with no model behind it is unset', () => {
    expect(tierOptions('codex', aliases, [], null)).toEqual([
      { tier: 'fable', availability: 'unset' },
      { tier: 'opus', availability: 'available' },
      { tier: 'sonnet', availability: 'available' },
      { tier: 'haiku', availability: 'unset' }
    ])
  })

  test('a tier the cell already holds on this provider is taken', () => {
    const routes = [line('codex', 'opus'), line('claude-code', 'sonnet')]
    expect(tierOptions('codex', aliases, routes, null).map((o) => o.availability)).toEqual([
      'unset',
      'taken',
      'available',
      'unset'
    ])
  })

  test('the line being changed does not take its own tier', () => {
    const routes = [line('codex', 'opus')]
    expect(tierOptions('codex', aliases, routes, 0)[1]).toEqual({ tier: 'opus', availability: 'available' })
  })

  test('with no alias list, nothing is claimed unset', () => {
    expect(tierOptions('codex', null, [], null).every((o) => o.availability === 'available')).toBe(true)
  })
})

describe('formatThreshold', () => {
  test('whole thousands from 100k up', () => {
    expect(formatThreshold(700_000)).toBe('700k')
    expect(formatThreshold(128_000)).toBe('128k')
    expect(formatThreshold(140_000)).toBe('140k')
    expect(formatThreshold(358_400)).toBe('358k')
  })

  test('one decimal under 100k, dropped when zero', () => {
    expect(formatThreshold(30_000)).toBe('30k')
    expect(formatThreshold(35_840)).toBe('35.8k')
  })

  test('millions, trailing zeros dropped', () => {
    expect(formatThreshold(1_000_000)).toBe('1M')
    expect(formatThreshold(1_200_000)).toBe('1.2M')
    expect(formatThreshold(999_800)).toBe('1M')
  })

  test('a small count is the count', () => {
    expect(formatThreshold(512)).toBe('512')
  })
})

test('emptyDraft has both lanes of all three scenarios, empty', () => {
  expect(emptyDraft()).toEqual({
    default: { agent: [], subagent: [] },
    think: { agent: [], subagent: [] },
    longContext: { agent: [], subagent: [] }
  })
})

/**
 * The chain → scenario routes planner, decision by decision.
 *
 * The planner runs once per profile on a live install and what it gets
 * wrong silently re-routes traffic, so each rule the plan document lists
 * is pinned here without a database: every list keeps its order and its
 * switches, an entry becomes its provider · the tier its model is, the
 * aliases go to the models most traffic reaches without overwriting one
 * already set, a tierless model takes a free slot, and duplicates within
 * a list collapse.
 */

import { describe, expect, test } from 'bun:test'
import type { RoutingLane, RoutingScenario } from '../../src/schemas/domain/tier-route'
import {
  type ChainEntryInput,
  type ConvertedLane,
  type ExistingAlias,
  type PlanInput,
  planTierRoutes
} from '../../src/services/routing-migration/plan-tier-routes'

const CLAUDE = { id: 'p-claude', name: 'claude-code', enabled: true }
const CODEX = { id: 'p-codex', name: 'codex', enabled: true }

const entry = (
  priority: number,
  provider: ChainEntryInput['provider'],
  name: string,
  over: { enabled?: boolean; modelEnabled?: boolean; manualTier?: string | null; deprecated?: boolean } = {}
): ChainEntryInput => ({
  priority,
  enabled: over.enabled === undefined ? true : over.enabled,
  model: {
    id: `m-${name}`,
    name,
    manualTier: over.manualTier === undefined ? null : over.manualTier,
    deprecated: over.deprecated === true,
    enabled: over.modelEnabled === undefined ? true : over.modelEnabled
  },
  provider
})

const lane = (scenario: RoutingScenario, name: RoutingLane, entries: ChainEntryInput[]): ConvertedLane => ({
  scenario,
  lane: name,
  entries
})

// The runner hands every list over, the default agent list first; a test
// names only the lists it is about.
const defaultAgent = (entries: ChainEntryInput[]) => lane('default', 'agent', entries)

const plan = (lanes: ConvertedLane[], over: Partial<PlanInput> = {}) =>
  planTierRoutes({ lanes, aliases: new Map<string, ExistingAlias>(), ignoredLanes: [], ...over })

const providerLabel = (providerId: string): string => (providerId === CLAUDE.id ? 'claude' : 'codex')

// "provider·tier[:off]" per route of one list, in order — easy to read in a failure.
const routesOf = (out: ReturnType<typeof planTierRoutes>, scenario: RoutingScenario, name: RoutingLane): string[] =>
  out.routes
    .filter((r) => r.scenario === scenario && r.lane === name)
    .map((r) => `${providerLabel(r.providerId)}·${r.targetTier}${r.enabled ? '' : ':off'}`)

// "provider|tier → model" per alias the plan creates.
const aliasesOf = (out: ReturnType<typeof planTierRoutes>): string[] =>
  out.aliases.map((a) => `${providerLabel(a.providerId)}|${a.tier} → ${a.modelId.slice(2)}`)

describe('planTierRoutes: lists', () => {
  test('every list converts in its own order, each entry to its provider · the tier its model is', () => {
    const out = plan([
      defaultAgent([entry(1, CLAUDE, 'claude-sonnet-5'), entry(2, CODEX, 'gpt-5.5')]),
      lane('default', 'subagent', [entry(1, CLAUDE, 'claude-haiku-4-5')]),
      lane('think', 'agent', [entry(1, CLAUDE, 'claude-opus-4-8'), entry(2, CLAUDE, 'claude-sonnet-5')]),
      lane('think', 'subagent', [entry(1, CLAUDE, 'claude-sonnet-5')]),
      lane('longContext', 'agent', [entry(1, CLAUDE, 'claude-fable-5')]),
      lane('longContext', 'subagent', [entry(1, CODEX, 'gpt-5.5')])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet', 'codex·sonnet'])
    expect(routesOf(out, 'default', 'subagent')).toEqual(['claude·haiku'])
    expect(routesOf(out, 'think', 'agent')).toEqual(['claude·opus', 'claude·sonnet'])
    expect(routesOf(out, 'think', 'subagent')).toEqual(['claude·sonnet'])
    expect(routesOf(out, 'longContext', 'agent')).toEqual(['claude·fable'])
    expect(routesOf(out, 'longContext', 'subagent')).toEqual(['codex·sonnet'])
    expect(out.notes).toEqual([])
  })

  test('priorities are renumbered from 1 per list, in the chain’s order however it arrives', () => {
    const out = plan([
      defaultAgent([entry(7, CODEX, 'gpt-5.5'), entry(3, CLAUDE, 'claude-sonnet-5')]),
      lane('think', 'agent', [entry(4, CLAUDE, 'claude-opus-4-8')])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet', 'codex·sonnet'])
    expect(out.routes.map((r) => `${r.scenario}/${r.lane}#${r.priority}`)).toEqual([
      'default/agent#1',
      'default/agent#2',
      'think/agent#1'
    ])
  })

  test('an entry switched off becomes a route switched off; one switched on stays on', () => {
    // The route carries the entry's own switch. Whether its model can take
    // traffic is read through the alias at request time, so an entry on a
    // model that is off is not switched off here.
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-5', { enabled: false }),
        entry(2, CODEX, 'gpt-5.5', { modelEnabled: false }),
        entry(3, CLAUDE, 'claude-opus-4-8')
      ])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet:off', 'codex·sonnet', 'claude·opus'])
  })

  test('a manual tier is the tier the entry was, over what its name says', () => {
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-5', { manualTier: 'opus' }),
        // A manual tier that is not a tier is ignored rather than trusted.
        entry(2, CLAUDE, 'claude-haiku-4-5', { manualTier: 'mega' })
      ])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·opus', 'claude·haiku'])
    expect(aliasesOf(out)).toEqual(['claude|opus → claude-sonnet-5', 'claude|haiku → claude-haiku-4-5'])
  })

  test('nothing to convert plans nothing', () => {
    expect(plan([defaultAgent([]), lane('think', 'subagent', [])])).toEqual({ aliases: [], routes: [], notes: [] })
  })
})

describe('planTierRoutes: aliases', () => {
  test("a provider's slot for a tier goes to the model the chain named", () => {
    const out = plan([defaultAgent([entry(1, CLAUDE, 'claude-sonnet-5'), entry(2, CLAUDE, 'claude-opus-4-8')])])
    expect(aliasesOf(out)).toEqual(['claude|sonnet → claude-sonnet-5', 'claude|opus → claude-opus-4-8'])
  })

  test('the default agent list claims first, ahead of a higher priority in another list', () => {
    // It is the list most traffic walks, so its model is the one the
    // provider's slot should name; the other list reaches it through the
    // alias, which the notes say.
    const out = plan([
      defaultAgent([entry(2, CLAUDE, 'claude-opus-4-8')]),
      lane('think', 'agent', [entry(1, CLAUDE, 'claude-opus-4-7')])
    ])
    expect(aliasesOf(out)).toEqual(['claude|opus → claude-opus-4-8'])
    expect(routesOf(out, 'think', 'agent')).toEqual(['claude·opus'])
    expect(out.notes).toEqual([
      "think/agent: claude-code,claude-opus-4-7 is reached through claude-code's opus alias, which is claude-opus-4-8"
    ])
  })

  test('within a list the higher priority claims first', () => {
    const out = plan([defaultAgent([entry(1, CLAUDE, 'claude-opus-4-8'), entry(2, CLAUDE, 'claude-opus-4-7')])])
    expect(aliasesOf(out)).toEqual(['claude|opus → claude-opus-4-8'])
  })

  test('a model that can serve claims before one that is off, even from a later list', () => {
    const out = plan([
      defaultAgent([entry(1, CLAUDE, 'claude-opus-4-7', { modelEnabled: false })]),
      lane('think', 'subagent', [entry(1, CLAUDE, 'claude-opus-4-8')])
    ])
    expect(aliasesOf(out)).toEqual(['claude|opus → claude-opus-4-8'])
  })

  test('an entry switched off, or on a provider that is off, claims after the ones that can serve', () => {
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-4-6', { enabled: false }),
        entry(2, { ...CLAUDE, enabled: false }, 'claude-sonnet-4-5'),
        entry(3, CLAUDE, 'claude-sonnet-5')
      ])
    ])
    expect(aliasesOf(out)).toEqual(['claude|sonnet → claude-sonnet-5'])
  })

  test('an alias already set is never overwritten, and the change of model is noted', () => {
    const out = plan([defaultAgent([entry(1, CLAUDE, 'claude-sonnet-5')])], {
      aliases: new Map([[`${CLAUDE.id}|sonnet`, { modelId: 'm-claude-sonnet-4-6', modelName: 'claude-sonnet-4-6' }]])
    })
    expect(out.aliases).toEqual([])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet'])
    expect(out.notes).toEqual([
      "default/agent: claude-code,claude-sonnet-5 is reached through claude-code's sonnet alias, which is claude-sonnet-4-6"
    ])
  })

  test('an alias already naming the model is no change and no note', () => {
    const out = plan([defaultAgent([entry(1, CLAUDE, 'claude-sonnet-5')])], {
      aliases: new Map([[`${CLAUDE.id}|sonnet`, { modelId: 'm-claude-sonnet-5', modelName: 'claude-sonnet-5' }]])
    })
    expect(out.aliases).toEqual([])
    expect(out.notes).toEqual([])
  })
})

describe('planTierRoutes: models whose name says no tier', () => {
  test('take a free slot, the tier most traffic asks for first', () => {
    const out = plan([defaultAgent([entry(1, CODEX, 'gpt-5.5'), entry(2, CODEX, 'gpt-5.5-mini')])])
    expect(aliasesOf(out)).toEqual(['codex|sonnet → gpt-5.5', 'codex|opus → gpt-5.5-mini'])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·sonnet', 'codex·opus'])
  })

  test('claim after every model that names a tier, so a named model keeps its own slot', () => {
    // gpt-5.5 is listed first, but could have taken any slot; the model
    // that says it is the Sonnet cannot.
    const out = plan([
      defaultAgent([entry(1, CODEX, 'gpt-5.5'), entry(2, CODEX, 'gpt-5.5-pro', { manualTier: 'sonnet' })])
    ])
    expect(aliasesOf(out)).toEqual(['codex|sonnet → gpt-5.5-pro', 'codex|opus → gpt-5.5'])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·opus', 'codex·sonnet'])
  })

  test('skip the slots an existing alias holds', () => {
    const out = plan([defaultAgent([entry(1, CODEX, 'gpt-5.5')])], {
      aliases: new Map([[`${CODEX.id}|sonnet`, { modelId: 'm-gpt-5.4', modelName: 'gpt-5.4' }]])
    })
    expect(aliasesOf(out)).toEqual(['codex|opus → gpt-5.5'])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·opus'])
    expect(out.notes).toEqual([])
  })

  test('keep the slot an existing alias already gives them', () => {
    const out = plan([defaultAgent([entry(1, CODEX, 'gpt-5.5')])], {
      aliases: new Map([[`${CODEX.id}|haiku`, { modelId: 'm-gpt-5.5', modelName: 'gpt-5.5' }]])
    })
    expect(out.aliases).toEqual([])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·haiku'])
  })

  test('claim one slot however many lists name them', () => {
    const out = plan([
      defaultAgent([entry(1, CODEX, 'gpt-5.5')]),
      lane('think', 'agent', [entry(1, CODEX, 'gpt-5.5')]),
      lane('longContext', 'subagent', [entry(1, CODEX, 'gpt-5.5')])
    ])
    expect(aliasesOf(out)).toEqual(['codex|sonnet → gpt-5.5'])
    expect(routesOf(out, 'think', 'agent')).toEqual(['codex·sonnet'])
    expect(routesOf(out, 'longContext', 'subagent')).toEqual(['codex·sonnet'])
  })

  test('with every slot taken, are reached through sonnet, and the notes say which model that is', () => {
    const held = (tier: string, model: string): [string, ExistingAlias] => [
      `${CODEX.id}|${tier}`,
      { modelId: `m-${model}`, modelName: model }
    ]
    const out = plan([defaultAgent([entry(1, CODEX, 'gpt-5.5')])], {
      aliases: new Map([
        held('fable', 'gpt-5.5-pro'),
        held('opus', 'gpt-5.4'),
        held('sonnet', 'gpt-5.4-mini'),
        held('haiku', 'gpt-5.4-nano')
      ])
    })
    expect(out.aliases).toEqual([])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·sonnet'])
    expect(out.notes).toEqual([
      "default/agent: codex,gpt-5.5 is reached through codex's sonnet alias, which is gpt-5.4-mini"
    ])
  })
})

describe('planTierRoutes: duplicates', () => {
  test('two models of one provider and tier in a list become one route, at the first one’s place', () => {
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-5'),
        entry(2, CODEX, 'gpt-5.5'),
        entry(3, CLAUDE, 'claude-sonnet-4-6')
      ])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet', 'codex·sonnet'])
    expect(out.notes).toEqual([
      "default/agent: claude-code,claude-sonnet-4-6 is reached through claude-code's sonnet alias, which is claude-sonnet-5",
      'default/agent: claude-code,claude-sonnet-4-6 collapsed into the claude-code · sonnet route already listed'
    ])
  })

  test('a later duplicate that is on rescues a route switched off earlier, at its own position', () => {
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-4-6', { enabled: false }),
        entry(2, CODEX, 'gpt-5.5'),
        entry(3, CLAUDE, 'claude-sonnet-5')
      ])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['codex·sonnet', 'claude·sonnet'])
  })

  test('a later duplicate that is off leaves an earlier one on, where it was', () => {
    const out = plan([
      defaultAgent([
        entry(1, CLAUDE, 'claude-sonnet-5'),
        entry(2, CODEX, 'gpt-5.5'),
        entry(3, CLAUDE, 'claude-sonnet-4-6', { enabled: false })
      ])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet', 'codex·sonnet'])
  })

  test('duplicates collapse within a list only: the same model in two lists is a route in each', () => {
    const out = plan([
      defaultAgent([entry(1, CLAUDE, 'claude-sonnet-5')]),
      lane('default', 'subagent', [entry(1, CLAUDE, 'claude-sonnet-5')])
    ])
    expect(routesOf(out, 'default', 'agent')).toEqual(['claude·sonnet'])
    expect(routesOf(out, 'default', 'subagent')).toEqual(['claude·sonnet'])
    expect(out.notes).toEqual([])
  })
})

describe('planTierRoutes: lists the conversion does not read', () => {
  test('are counted in the notes, and an empty one is not mentioned', () => {
    const out = plan([], {
      ignoredLanes: [
        { lane: 'webSearch/agent', count: 2 },
        { lane: 'image/subagent', count: 1 },
        { lane: 'webSearch/subagent', count: 0 }
      ]
    })
    expect(out.notes).toEqual([
      'webSearch/agent: 2 entries not converted (web search and image are no longer scenarios)',
      'image/subagent: 1 entry not converted (web search and image are no longer scenarios)'
    ])
    expect(out.routes).toEqual([])
    expect(out.aliases).toEqual([])
  })
})

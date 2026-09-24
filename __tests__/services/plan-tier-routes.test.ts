/**
 * The chain → tier map planner, decision by decision.
 *
 * The planner runs once per profile on a live install and what it gets
 * wrong silently re-routes traffic, so each rule the plan document lists
 * is pinned here without a database.
 */

import { describe, expect, test } from 'bun:test'
import {
  type ChainEntryInput,
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

const plan = (entries: ChainEntryInput[], over: Partial<PlanInput> = {}) =>
  planTierRoutes({
    entries,
    allowEscalation: true,
    allowDemotion: true,
    tierFallback: 'nearest',
    aliases: new Map<string, ExistingAlias>(),
    ignoredLanes: [],
    ...over
  })

// "requested: provider·tier[:off]" per route, in order — easy to read in a failure.
const routesOf = (out: ReturnType<typeof planTierRoutes>, requested: string): string[] =>
  out.routes
    .filter((r) => r.requestedTier === requested)
    .map((r) => `${r.providerId === CLAUDE.id ? 'claude' : 'codex'}·${r.targetTier}${r.enabled ? '' : ':off'}`)

describe('planTierRoutes', () => {
  test('a Sonnet-only chain with "down only": Haiku keeps being served by Sonnet, as P0-1 made it', () => {
    const out = plan([entry(1, CLAUDE, 'claude-sonnet-5')], { allowEscalation: false })
    expect(out.aliases).toEqual([{ providerId: CLAUDE.id, tier: 'sonnet', modelId: 'm-claude-sonnet-5' }])
    expect(routesOf(out, 'sonnet')).toEqual(['claude·sonnet'])
    // Demotion is allowed, so Opus and Fable requests were served by it too.
    expect(routesOf(out, 'opus')).toEqual(['claude·sonnet'])
    expect(routesOf(out, 'fable')).toEqual(['claude·sonnet'])
    expect(routesOf(out, 'haiku')).toEqual(['claude·sonnet'])
    expect(out.notes.some((n) => n.startsWith('haiku: no route of an allowed tier'))).toBe(true)
    // A request naming no Claude family was never tier-gated.
    expect(routesOf(out, 'other')).toEqual(['claude·sonnet'])
  })

  test("tierFallback 'refuse' leaves the refused route switched off", () => {
    const out = plan([entry(1, CLAUDE, 'claude-sonnet-5')], { allowEscalation: false, tierFallback: 'refuse' })
    expect(routesOf(out, 'haiku')).toEqual(['claude·sonnet:off'])
  })

  test('the fallback orders the refused routes nearest first, cheaper first on a tie', () => {
    const out = plan([entry(1, CLAUDE, 'claude-opus-4-8'), entry(2, CLAUDE, 'claude-haiku-4-5')], {
      allowEscalation: false,
      allowDemotion: false
    })
    expect(routesOf(out, 'sonnet')).toEqual(['claude·haiku', 'claude·opus'])
  })

  test('two models of one provider and tier become one route to its alias', () => {
    const out = plan([entry(1, CLAUDE, 'claude-opus-4-8'), entry(2, CLAUDE, 'claude-opus-4-7')])
    expect(out.aliases).toEqual([{ providerId: CLAUDE.id, tier: 'opus', modelId: 'm-claude-opus-4-8' }])
    expect(routesOf(out, 'opus')).toEqual(['claude·opus'])
    expect(out.notes.some((n) => n.includes('claude-opus-4-7 collapsed'))).toBe(true)
  })

  test('a model that names no Claude family is aliased as the tier it served', () => {
    const out = plan([entry(1, CLAUDE, 'claude-sonnet-5'), entry(2, CODEX, 'gpt-5.5')])
    const codexAliases = out.aliases.filter((a) => a.providerId === CODEX.id).map((a) => a.tier)
    expect(codexAliases.sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    expect(routesOf(out, 'sonnet')).toEqual(['claude·sonnet', 'codex·sonnet'])
    expect(routesOf(out, 'haiku')).toEqual(['claude·sonnet', 'codex·haiku'])
    // For "other" it goes through a tier it already holds.
    expect(routesOf(out, 'other')).toEqual(['claude·sonnet', 'codex·fable'])
  })

  test('an alias already set is never overwritten, and the change of model is noted', () => {
    const out = plan([entry(1, CLAUDE, 'claude-sonnet-5')], {
      aliases: new Map([[`${CLAUDE.id}|sonnet`, { modelId: 'm-claude-sonnet-4-6', modelName: 'claude-sonnet-4-6' }]])
    })
    expect(out.aliases).toEqual([])
    expect(routesOf(out, 'sonnet')).toEqual(['claude·sonnet'])
    expect(out.notes).toContain(
      "sonnet: claude-code,claude-sonnet-5 is reached through claude-code's sonnet alias, which is claude-sonnet-4-6"
    )
  })

  test('the alias goes to a model that can serve before one that is off, even further down', () => {
    const out = plan([
      entry(1, CLAUDE, 'claude-opus-4-7', { modelEnabled: false }),
      entry(2, CLAUDE, 'claude-opus-4-8')
    ])
    expect(out.aliases).toEqual([{ providerId: CLAUDE.id, tier: 'opus', modelId: 'm-claude-opus-4-8' }])
  })

  test('an entry switched off becomes a route switched off', () => {
    const out = plan([entry(1, CLAUDE, 'claude-sonnet-5', { enabled: false }), entry(2, CODEX, 'gpt-5.5')])
    expect(routesOf(out, 'sonnet')).toEqual(['claude·sonnet:off', 'codex·sonnet'])
  })

  test('a later duplicate that can serve rescues a route switched off earlier, at its own position', () => {
    const out = plan([
      entry(1, CLAUDE, 'claude-sonnet-4-6', { enabled: false }),
      entry(2, CODEX, 'gpt-5.5'),
      entry(3, CLAUDE, 'claude-sonnet-5')
    ])
    expect(routesOf(out, 'sonnet')).toEqual(['codex·sonnet', 'claude·sonnet'])
  })

  test('lanes the conversion does not read are counted in the notes', () => {
    const out = plan([], {
      ignoredLanes: [
        { lane: 'think/agent', count: 2 },
        { lane: 'default/subagent', count: 0 }
      ]
    })
    expect(out.notes).toEqual(['think/agent: 2 entries not converted (lanes other than default/agent are gone)'])
    expect(out.routes).toEqual([])
  })
})

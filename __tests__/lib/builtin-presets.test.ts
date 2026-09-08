/**
 * Resolving a built-in preset's tier chain against an install.
 *
 * The presets ship as tiers precisely because the models differ per
 * install, so the interesting cases are all about what is missing: a
 * tier nobody has a model for, a chain that resolves to nothing, and the
 * same model matching two links of one chain.
 */

import { describe, expect, test } from 'bun:test'
import type { EnabledTarget } from '../../src/components/rialto/routing/types'
import { resolveBuiltinPreset, resolvesToNothing, resolveTierChain } from '../../src/lib/routing-map/builtin-presets'
import { BUILTIN_ROUTING_PRESETS, type BuiltinRoutingPreset } from '../../src/shared/data'

const target = (name: string, tier: EnabledTarget['tier']): EnabledTarget => ({
  target: name,
  provider: name.split(',')[0],
  model: name.split(',')[1],
  tier
})

const FULL_HOUSE: EnabledTarget[] = [
  target('claude-code,claude-fable-5', 'fable'),
  target('claude-code,claude-opus-4-8', 'opus'),
  target('claude-code,claude-sonnet-5', 'sonnet'),
  target('claude-code,claude-haiku-4-5', 'haiku'),
  // An api_key model whose name says nothing about a Claude family.
  target('openai,gpt-5.6-terra', null)
]

const byId = (id: string): BuiltinRoutingPreset => {
  const found = BUILTIN_ROUTING_PRESETS.find((p) => p.id === id)
  if (found === undefined) throw new Error(`no built-in preset ${id}`)
  return found
}

describe('resolveTierChain', () => {
  test('maps each tier to the first enabled model at that tier', () => {
    expect(resolveTierChain(['fable', 'opus'], FULL_HOUSE)).toEqual([
      'claude-code,claude-fable-5',
      'claude-code,claude-opus-4-8'
    ])
  })

  test('drops a tier nothing serves rather than substituting a neighbour', () => {
    const noFable = FULL_HOUSE.filter((t) => t.tier !== 'fable')
    // The whole point of shipping tiers: "Max quality" must not quietly
    // become a haiku chain on an install without a top-tier model.
    expect(resolveTierChain(['fable', 'opus'], noFable)).toEqual(['claude-code,claude-opus-4-8'])
  })

  test('never repeats a model inside one chain', () => {
    const onlyOne = [target('solo,model-a', 'sonnet')]
    expect(resolveTierChain(['sonnet', 'sonnet', 'sonnet'], onlyOne)).toEqual(['solo,model-a'])
  })

  test('an untiered model is never picked by a tier chain', () => {
    expect(resolveTierChain(['fable', 'opus', 'sonnet', 'haiku'], [target('openai,gpt-5.6-terra', null)])).toEqual([])
  })
})

describe('resolveBuiltinPreset', () => {
  test('Max quality leads with the top tier and drops the subagent lane one down', () => {
    const config = resolveBuiltinPreset(byId('builtin-max-quality'), FULL_HOUSE)
    expect(config.default.agent.primary).toBe('claude-code,claude-fable-5')
    expect(config.default.subagent.primary).toBe('claude-code,claude-sonnet-5')
  })

  test('Cost saver leads with the bottom tier but steps up to think', () => {
    const config = resolveBuiltinPreset(byId('builtin-cost-saver'), FULL_HOUSE)
    expect(config.default.agent.primary).toBe('claude-code,claude-haiku-4-5')
    expect(config.think.agent.primary).toBe('claude-code,claude-sonnet-5')
  })

  test('webSearch and image follow the default lane', () => {
    const config = resolveBuiltinPreset(byId('builtin-max-quality'), FULL_HOUSE)
    expect(config.webSearch.agent.primary).toBe(config.default.agent.primary)
    expect(config.image.agent.primary).toBe(config.default.agent.primary)
  })

  test('longContext keeps the automatic threshold', () => {
    expect(resolveBuiltinPreset(byId('builtin-cost-saver'), FULL_HOUSE).longContext.threshold).toBeNull()
  })

  test('an install with no tiered model resolves to nothing, and says so', () => {
    for (const preset of BUILTIN_ROUTING_PRESETS) {
      const config = resolveBuiltinPreset(preset, [target('openai,gpt-5.6-terra', null)])
      expect(resolvesToNothing(config)).toBe(true)
    }
  })

  test('every shipped preset resolves on a full install', () => {
    for (const preset of BUILTIN_ROUTING_PRESETS) {
      expect(resolvesToNothing(resolveBuiltinPreset(preset, FULL_HOUSE))).toBe(false)
    }
  })
})

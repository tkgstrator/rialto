/**
 * Turning a built-in preset's tier chain into a routable Router config.
 *
 * The resolution is deliberately late — at apply time, against the
 * models the operator has enabled right now — so the shipped preset
 * never has to know what this install connected. A tier nobody has a
 * model for is dropped from the chain rather than filled with the
 * nearest thing: quietly substituting a haiku where the preset asked for
 * opus is the one failure mode a preset called "Max quality" must not
 * have.
 *
 * Pure and React-free so the mapping can be tested without a screen.
 */

import type { EnabledTarget } from '@/components/rialto/routing/types'
import type { RouterConfig } from '@/schemas/domain/router'
import type { BuiltinRoutingPreset, ModelTier } from '@/shared/data'

/**
 * The first enabled model at each tier, in chain order, no repeats.
 *
 * "First" is the order `enabledTargets` produced — provider order, then
 * model name — which is the same order the model picker offers, so what
 * a preset resolves to matches what the operator would have picked by
 * hand from the same list.
 */
export function resolveTierChain(tiers: readonly ModelTier[], targets: readonly EnabledTarget[]): string[] {
  const used = new Set<string>()
  const chain: string[] = []
  for (const tier of tiers) {
    const match = targets.find((candidate) => candidate.tier === tier && !used.has(candidate.target))
    if (match === undefined) continue
    used.add(match.target)
    chain.push(match.target)
  }
  return chain
}

const route = (chain: readonly string[]) => ({
  primary: chain.length === 0 ? null : chain[0],
  fallbacks: [...chain.slice(1)],
  rules: []
})

/**
 * `webSearch` and `image` follow the default lane: neither has a model
 * choice of its own to make here, and a preset that quietly sent them
 * somewhere else would be doing something its name does not advertise.
 * `threshold: null` leaves longContext on the automatic threshold (70%
 * of the default primary's context window) rather than pinning a number
 * the preset cannot know.
 */
export function resolveBuiltinPreset(preset: BuiltinRoutingPreset, targets: readonly EnabledTarget[]): RouterConfig {
  const subagent = route(resolveTierChain(preset.chains.subagent, targets))
  const main = { agent: route(resolveTierChain(preset.chains.agent, targets)), subagent }
  return {
    default: main,
    think: { agent: route(resolveTierChain(preset.chains.think, targets)), subagent },
    longContext: {
      agent: route(resolveTierChain(preset.chains.longContext, targets)),
      subagent,
      threshold: null
    },
    webSearch: main,
    image: main,
    persona: null
  }
}

/**
 * Whether applying would leave the router with nothing to route to.
 *
 * An install with no model at any of the preset's tiers would otherwise
 * save a Router whose every primary is null — which is not "the preset
 * did not fit", it is an outage. The caller refuses and says so.
 */
export function resolvesToNothing(config: RouterConfig): boolean {
  return config.default.agent.primary === null
}

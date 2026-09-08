/**
 * The Routing presets every install ships with.
 *
 * Defined as chains of TIERS, not of `provider,model` pairs. A preset
 * that named models would be wrong on arrival for most installs: which
 * models exist depends on which vendor the operator connected, the ids
 * move every release, and a fresh database has none at all. A tier
 * survives all three — "the opus-class model this install has" is still
 * answerable next quarter.
 *
 * They live in code rather than as seeded `RoutingPreset` rows because
 * they are not the operator's data: there is nothing to migrate, nothing
 * to reconcile when a row is edited or deleted, and no way for a stale
 * copy to outlive the definition. Saving one as your own is what the
 * ordinary "save snapshot" path is for — apply, adjust, save.
 *
 * Resolution to concrete targets happens at apply time; see
 * `lib/routing-map/builtin-presets.ts`.
 */

// The tier vocabulary, expensive → cheap. Mirrors `RequestedModelTier`
// (schemas/domain/router) and `Tier` (components/rialto/routing/types);
// kept as plain data here because `src/shared` is bundled into the
// browser and must not reach into either.
const MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export interface BuiltinRoutingPreset {
  /** Stable across releases: the rail keys rows by it. */
  id: string
  /**
   * Not localised on purpose. Applying a preset writes its name to
   * `LiveRoutingName` in the config envelope, where a translated string
   * would make the stored config depend on the operator's UI language.
   */
  name: string
  /** Preference order per lane, best-first. Unresolvable tiers drop out. */
  chains: {
    agent: readonly ModelTier[]
    subagent: readonly ModelTier[]
    think: readonly ModelTier[]
    longContext: readonly ModelTier[]
  }
}

export const BUILTIN_ROUTING_PRESETS: readonly BuiltinRoutingPreset[] = [
  {
    id: 'builtin-max-quality',
    name: 'Max quality',
    chains: {
      agent: ['fable', 'opus', 'sonnet'],
      // One tier down on purpose. Subagent traffic is mostly mechanical
      // — search, summarise, read a file — and running it at the top
      // tier is exactly where a "max quality" chain burns a plan without
      // improving an answer anybody reads.
      subagent: ['sonnet', 'haiku'],
      think: ['fable', 'opus'],
      longContext: ['fable', 'opus']
    }
  },
  {
    id: 'builtin-cost-saver',
    name: 'Cost saver',
    chains: {
      agent: ['haiku', 'sonnet'],
      subagent: ['haiku'],
      // Cheap is the default, not a ceiling: a reasoning request on the
      // bottom tier costs less per token and more per answer, so both
      // scenarios that exist because the request is hard step up one.
      think: ['sonnet', 'opus'],
      longContext: ['sonnet', 'opus']
    }
  }
]

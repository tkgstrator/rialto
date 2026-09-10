/**
 * Preference-based routing schemas (docs/plan/quota-aware-preference-router.md
 * §6.3). Defines the wire shape of the singleton `RouterPreferenceProfile`
 * plus its ordered entries, and the two constraints tiers:
 *
 *   - `PreferenceConstraintsSchema`  — L4 gate-only selector knobs
 *   - `QuotaAwareConstraintsSchema`  — extends the above with the
 *                                       scheduler-owned scoring/weight
 *                                       knobs used by the quota-aware
 *                                       selector.
 *
 * The DB stores `constraints` as JSONB with no schema-level knowledge,
 * so schema extension = **no migration**. Both schemas apply `.default()`
 * to every knob so an empty/null blob validates to the safe zero-config
 * defaults.
 */

import { z } from '@hono/zod-openapi'
import { REQUESTED_MODEL_TIERS, ScenarioKeySchema } from './router'

// The tier the client asked for is always classified into one of these
// buckets before the selector runs; `subagentTiers` filters candidates
// by their own tier during subagent calls (Open Question 11 decision).
export const RequestedModelTierSchema = z.enum(REQUESTED_MODEL_TIERS)

// Level 4 gate-only constraints. Kept as a base so the quota-aware
// schema can `.extend()` it without duplicating the L4 knobs. Every
// field defaults so a null/absent constraints JSONB parses cleanly.
export const PreferenceConstraintsSchema = z
  .object({
    // Two directional tier-substitution gates, replacing the previous
    // per-tier `sonnetTierRespect` / `haikuTierRespect` design that only
    // covered upward escalation of sonnet/haiku requests. Now
    // symmetric and universal:
    //   - `allowEscalation`: a candidate whose tier is ABOVE the
    //     requested tier (e.g. opus candidate for a sonnet request)
    //     matches when true. `false` pins requests to same-or-lower
    //     tiers only.
    //   - `allowDemotion`: a candidate whose tier is BELOW the
    //     requested tier (e.g. haiku candidate for a sonnet request)
    //     matches when true. `false` pins requests to same-or-higher
    //     tiers only.
    // With both true (default), tier is a hint but not a gate — every
    // candidate participates. With both false, only same-tier
    // candidates ever match.
    allowEscalation: z.boolean().default(true),
    allowDemotion: z.boolean().default(true),
    // Intended to skip a candidate whose usage percentage is >= this
    // threshold (0-100). Stored and shown on the Routing screen, but
    // nothing on the request path reads it yet: the selector's
    // exhaustion gate reads only the scheduler's weight snapshot
    // (`buildIsExhausted` in quota-router/runtime.ts).
    quotaSkipPct: z.number().min(0).max(100).default(100),
    // Skip a candidate whose observed 5-min error rate is >= this
    // threshold (0-1). Zero disables the check.
    errorRateSkipPct: z.number().min(0).max(1).default(0.5),
    // Minimum number of recent samples before `errorRateSkipPct`
    // engages. Prevents a single early error from evicting a fresh
    // model.
    minHealthSamples: z.number().int().min(0).default(5),
    // Pace-aware tier auto-shift. paceRatio = consumed% / elapsed% on
    // the account's binding window:
    //   > paceOverThreshold   → the tier is burning through its budget
    //     too fast, allow one tier BELOW the requested tier (e.g. Fable
    //     request served by Opus) so the pricey lane cools off.
    //   < paceUnderThreshold  → the tier will end the window with slack
    //     budget, allow one tier ABOVE the requested tier (e.g. Sonnet
    //     request served by Opus) to burn the subscription rather than
    //     let it reset unused.
    // Both bounds are permissive (default 1.5 / 0.5) — a strict 1.0
    // pin would flip on inevitable sleep periods and early-window
    // cold starts. Set either to null/1 to disable that direction.
    paceOverThreshold: z.number().positive().default(1.5),
    paceUnderThreshold: z.number().positive().default(0.5),
    // Skip the pace-based tier logic entirely until at least this
    // fraction of the window has elapsed. Early in the window the
    // paceRatio numerator is noisy — a single request out of the gate
    // looks like a 100x pace.
    pacePolicyMinElapsedPct: z.number().min(0).max(100).default(20)
  })
  .openapi('PreferenceConstraints')
export type PreferenceConstraints = z.infer<typeof PreferenceConstraintsSchema>

// Quota-aware extension. Adds the scheduler-owned scoring knobs; each
// field has a plan-doc-backed default so the "no user config" case
// still produces sane weights.
export const QuotaAwareConstraintsSchema = PreferenceConstraintsSchema.extend({
  // Candidates whose published weight is below this are skipped by the
  // selector (except probe traffic — see minWeightPct).
  healthinessThreshold: z.number().min(0).max(1).default(0.05),
  // Weight floor (%) for any enabled candidate with healthiness > 0,
  // so a recovering account keeps receiving probe traffic. 1% = one in
  // 100 requests goes to a nearly-exhausted candidate as a probe.
  minWeightPct: z.number().min(0).max(10).default(1),
  // Max absolute weight movement per tick (oscillation damper). At
  // 5min+ ticks this rarely fires; kept as a safety belt for
  // shadow/staging 60s ticks and setting-error protection.
  maxDeltaPerTick: z.number().min(0.01).max(1).default(0.2),
  // Whether the damper is active at all. Plan doc §8.2 notes that
  // long-tick deployments can leave it off.
  dampenerEnabled: z.boolean().default(true),
  // "Reset is near" downweight: applies when timeToReset <
  // resetSoonMinutes AND remaining < resetSoonRemainingPct.
  resetSoonMinutes: z.number().int().positive().default(10),
  resetSoonRemainingPct: z.number().min(0).max(100).default(10),
  resetSoonFactor: z.number().min(0).max(1).default(0.25),
  // Multiplier applied when quotaRefreshedAt is older than 3x the
  // poll TTL — "unknown but was known" budget → route conservatively.
  staleQuotaFactor: z.number().min(0).max(1).default(0.25),
  // Cold-start (never observed) behaviour: allow at full weight or
  // demote. The plan doc's chosen default is `allow` per the
  // "empty cache = available" convention already in the codebase.
  unknownBudgetPolicy: z.enum(['allow', 'demote']).default('allow'),
  // What to do when every enabled candidate is exhausted. '429'
  // returns a rate_limit_error with Retry-After (Open Question 2
  // decision); 'passthrough' keeps the client's own model.
  exhaustedBehavior: z.enum(['429', 'passthrough']).default('429'),
  // Token count above which a request is classified into the
  // `longContext` lane. `null` means "auto": the classifier derives the
  // threshold from the context window of the chain's top default/agent
  // target (× 0.7, leaving headroom for the reply), and falls back to
  // 128k when that model has no scraped window. A number pins it.
  longContextThreshold: z.number().int().positive().nullable().default(null)
}).openapi('QuotaAwareConstraints')
export type QuotaAwareConstraints = z.infer<typeof QuotaAwareConstraintsSchema>

// One entry in the preference chain. `target` is the "providerName,modelName"
// string the failover walker and the log lines use, so every code path
// names a model the same way. `priority` is 1-based, 1 = most preferred.
// `enabled` is a soft toggle — the row stays in the DB (and its priority
// slot) but the selector skips the entry when false.
export const RouterPreferenceEntrySchema = z
  .object({
    priority: z.number().int().positive(),
    target: z.string().nonempty(),
    enabled: z.boolean().default(true),
    // Server-populated on read: whether the entry's model AND its
    // provider are enabled. Separate from `enabled` so the Routing
    // screen can tell "entry switched off" from "target switched off"
    // — the first is its own toggle, the second is the Providers
    // screen's. The request path folds the two together
    // (`loadRoutableProfile`); the apply path ignores this field.
    targetEnabled: z.boolean().optional(),
    // Per-entry tier-substitution overrides. When set they take
    // precedence over the global `constraints.allowEscalation` /
    // `allowDemotion` for THIS candidate only, letting operators pin
    // "Fable never as a substitute for Sonnet, but Opus may be" without
    // flipping the constraint for every row. Undefined = inherit the
    // global constraint (backwards-compatible with pre-2026-08 payloads
    // that only carried the two global flags).
    allowEscalation: z.boolean().optional(),
    allowDemotion: z.boolean().optional(),
    // Server-populated on read (loadPreferenceChain resolves it from
    // Model.manualTier ?? tierOf(name)). Optional on the wire because
    // legacy clients don't send it and the apply path ignores it —
    // resolvedTier is a computed value, not user input.
    resolvedTier: RequestedModelTierSchema.nullable().optional()
  })
  .openapi('RouterPreferenceEntry')
export type RouterPreferenceEntry = z.infer<typeof RouterPreferenceEntrySchema>

// Preference kinds — mirrors the RouterPreferenceKind Prisma enum.
// `agent` is the main-agent chain (no <RIALTO-SUBAGENT-MODEL> tag);
// `subagent` is the chain requests carrying the tag route through.
export const PreferenceKindSchema = z.enum(['agent', 'subagent'])
export type PreferenceKind = z.infer<typeof PreferenceKindSchema>

// Per-kind chains inside one scenario — an agent chain and a subagent
// chain that are ordered independently. Both keys are always present on
// the wire so the UI can render an empty sub-tab without a "missing"
// branch.
export const PreferenceEntriesByKindSchema = z
  .object({
    agent: z.array(RouterPreferenceEntrySchema).default([]),
    subagent: z.array(RouterPreferenceEntrySchema).default([])
  })
  .openapi('PreferenceEntriesByKind')
export type PreferenceEntriesByKind = z.infer<typeof PreferenceEntriesByKindSchema>

// Per-scenario map of preference chains. Every scenario key is present
// on the wire so the UI can render an empty tab without a special
// "missing scenario" branch. Each scenario now owns TWO ordered chains
// (agent + subagent) rather than a single shared chain — the selector
// picks the chain matching the incoming request's classified scenario
// AND its caller kind.
export const PreferenceEntriesByScenarioSchema = z
  .object({
    default: PreferenceEntriesByKindSchema.default({ agent: [], subagent: [] }),
    think: PreferenceEntriesByKindSchema.default({ agent: [], subagent: [] }),
    longContext: PreferenceEntriesByKindSchema.default({ agent: [], subagent: [] }),
    webSearch: PreferenceEntriesByKindSchema.default({ agent: [], subagent: [] }),
    image: PreferenceEntriesByKindSchema.default({ agent: [], subagent: [] })
  })
  .openapi('PreferenceEntriesByScenario')
export type PreferenceEntriesByScenario = z.infer<typeof PreferenceEntriesByScenarioSchema>

// Full preference profile as seen on the wire. `constraints` is a
// permissive object because it round-trips through JSONB; the selector
// parses it through `QuotaAwareConstraintsSchema` per request, so a
// knob added to the schema needs no migration.
export const RouterPreferenceProfileSchema = z
  .object({
    entriesByScenario: PreferenceEntriesByScenarioSchema,
    constraints: z.record(z.string().nonempty(), z.any()).nullable().default(null)
  })
  .openapi('RouterPreferenceProfile')
export type RouterPreferenceProfile = z.infer<typeof RouterPreferenceProfileSchema>

export type { ScenarioKey } from './router'
// Re-export the shared enum so callers that touch the preference
// schema get a single source of scenario keys.
export const PREFERENCE_SCENARIOS = ScenarioKeySchema

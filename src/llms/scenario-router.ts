/**
 * Scenario-based model routing.
 *
 * Reads the inbound request and the configured `Router` map (default /
 * think / longContext / webSearch / image) and rewrites `body.model` to
 * the model the request should actually hit. The scenario the router
 * landed on is stamped onto the request so the pipeline can shape its
 * log lines. Per-scenario `rules[]` predicated overrides run inside
 * selectModel and produce the fallback chain the failover paths walk.
 *
 * @deprecated Scheduled for removal after `ROUTER_MODE=quota-aware`
 * reaches 100% rollout for a full release cycle. Migrate to the
 * preference-based selector: set `ROUTER_MODE=quota-aware` and
 * configure the chain via `/router-preferences`. See
 * docs/plan/quota-aware-router-post-phase-4.md §Phase 8 for the
 * staged deletion timeline (planned v3.0.0).
 *
 * Port of vendor utils/router.ts, tightened to strict types: the
 * request body is now `RouterRequestBody` and the router config is
 * `RouterConfig` (mirrors AppConfig.Router from src/schemas).
 *
 * This file wires the pieces together; the pieces themselves live under
 * `./scenario-router/`: shared types, proactive failover, the
 * `selectModel` heuristics, persona/system-prompt injection, and the
 * per-session/per-project Router override lookup.
 */

import type { RouterPreferenceProfile } from '@/schemas/domain'
import type { FlatRouter } from '@/schemas/domain/router'
import { isRoutedPath, resolveSurfaceForPath } from '../services/inbound-surface-service'
import { loadRouterPreferences, PASSTHROUGH_PROFILE_KEY } from '../services/router-preference-service'
import { getRoutingSnapshot } from '../services/routing-scheduler/state'
import { chainRoutingOf, resolveQuotaAwareSelection } from './quota-router/runtime'
import { applyProactiveFailover } from './scenario-router/failover'
import type { ChainRouting } from './scenario-router/model-selection'
import { selectModel } from './scenario-router/model-selection'
import { expandChainWithPeers, type HealthinessLookup } from './scenario-router/peer-fallback'
import { applyGlobalSystemPrompt, resolveActivePersonaPrompt } from './scenario-router/persona'
import { getProjectRouter } from './scenario-router/project-config'
import { signalsOf } from './scenario-router/surface-signals'
import type {
  ConfigProvider,
  RouterConfig,
  RouterContext,
  RouterRequest,
  RouterRequestBody
} from './scenario-router/types'
import type { TokenizeRequest } from './tokenizers/base'

const readCrossProviderFallback = (): boolean => process.env.CROSS_PROVIDER_FALLBACK === 'true'

// Route resolver-side view of the quota-aware scheduler's published
// weight snapshot. Wraps `getRoutingSnapshot()` so peer-fallback can
// order peers by healthiness without importing the snapshot type. A
// missing snapshot (scheduler off, cold-start) collapses to `undefined`
// per target, which peer-fallback treats as an average score.
const healthinessLookup: HealthinessLookup = (target) => {
  const snapshot = getRoutingSnapshot()
  return snapshot?.weights.get(target)?.healthiness
}

// Build the enriched (primary + fallbacks + peerTargets) triple the
// downstream failover paths consume. Split out of routeScenario so that
// hot path stays under the biome cognitive-complexity budget and unit
// tests exercising peer expansion can reach the helper directly.
const applyPeerFallback = (
  model: string,
  fallbacks: readonly string[],
  ctx: RouterContext
): { primary: string; fallbacks: string[]; peerTargets: ReadonlySet<string> } => {
  const providers = ctx.config.get<ConfigProvider[]>('providers', [])
  const expanded = expandChainWithPeers(model, fallbacks, providers, healthinessLookup, readCrossProviderFallback())
  // expanded.chain is constructed as [model, ...] so [0] is always the
  // primary; the guarded fallback documents the invariant for readers
  // and satisfies noNonNullAssertion / no-??-fallback lint rules.
  const firstEntry = expanded.chain[0]
  const primary = firstEntry === undefined ? model : firstEntry
  return { primary, fallbacks: expanded.chain.slice(1), peerTargets: expanded.peerTargets }
}

// Load the preference chain when it is what routes this request, and
// project it into the shape the classifier reads. Null when the chain is
// not the live selector: the rules path has to keep the RouterSlot-only
// gate, because a chain lane it cannot serve would send the request to
// the caller's own model instead of the default primary.
//
// Split out of routeScenario for the same reason applyPeerFallback is —
// that function is already over the biome cognitive-complexity budget.
const loadChainRouting = async (
  active: boolean,
  profileKey: string | undefined,
  ctx: RouterContext,
  log: RouterRequest['log']
): Promise<{ profile: RouterPreferenceProfile; routing: ChainRouting } | null> => {
  if (!active) return null
  const providers = ctx.config.get<ConfigProvider[]>('providers', [])
  try {
    const profile = await loadRouterPreferences(undefined, profileKey)
    return { profile, routing: chainRoutingOf(profile, providers) }
  } catch (err) {
    // The chain lives in Postgres; the scenario classification does not.
    // Letting this reach routeScenario's outer catch would cost the whole
    // decision — lane, rules, per-project override — and answer every
    // request with `Router.default` for as long as the database is away.
    // A chain we cannot read is a chain that contributes nothing, which
    // is exactly what `null` means here: fall through to the scenario
    // router, the same answer this install gave before the chain existed.
    log.warn({ err }, '[routing-quota-aware] could not load the preference chain — using the scenario router')
    return null
  }
}

export type { ScenarioRouterConfig as RouterConfig, ScenarioType } from '@/schemas/domain/scenario'
export type { SubscriptionKindProvider } from './scenario-router/failover'
export { applyProactiveFailover, candidateUsable, subscriptionKindOf } from './scenario-router/failover'
export type { ChainRouting, EffortLevel, ModelTier } from './scenario-router/model-selection'
export { isHeavyRequest, selectModel } from './scenario-router/model-selection'
export type { RouterContext, RouterRequest, RouterRequestBody } from './scenario-router/types'

/**
 * Mutates `req.body.model` to the selected target model and stamps
 * `req.scenarioType`. Errors fall back to `Router.default` so the
 * router never aborts the pipeline.
 */
export async function routeScenario(req: RouterRequest, ctx: RouterContext): Promise<void> {
  // metadata.user_id may carry "<user>_session_<id>" — strip the session
  // out so project-specific config can pick the matching profile.
  const userId = req.body.metadata?.user_id
  if (userId) {
    const parts = userId.split('_session_')
    if (parts.length > 1) req.sessionId = parts[1]
  }

  // Passthrough surfaces: the caller hand-picks its target with
  // `provider,model` in body.model and expects that exact model to reach
  // upstream — the scenario map, per-project overrides, rule stack, and
  // quota-aware selector are all Anthropic-idiom conveniences that would
  // silently rewrite the caller's choice. Skip the whole selector, leave
  // body.model as-is, and stamp default-scenario metadata so the
  // downstream pipeline has the fields it reads.
  //
  // Which surfaces those are is configuration, not a constant. Every
  // surface carries an explicit mode, set from the Routing screen; there
  // is no per-surface default for this to fall back to.
  // A token may name the reserved passthrough profile, which opts that
  // one client out of routing without changing the mode for everyone
  // else sharing the endpoint.
  const forcedPassthrough = req.profileKeyOverride === PASSTHROUGH_PROFILE_KEY

  if (forcedPassthrough || !(await isRoutedPath(req.inboundPath))) {
    req.scenarioType = 'default'
    req.isSubagent = false
    req.resolvedFallbacks = []
    return
  }

  try {
    const tokenCount = await countRequestTokens(ctx.tokenizers, signalsOf(req).tokenize)
    req.tokenCount = tokenCount

    const project = await getProjectRouter(req)
    const globalRouter = ctx.config.get<RouterConfig>('Router')
    // Project-level override wins; fall through to the global Router map
    // when no per-project file applies.
    const router: RouterConfig | undefined = project !== undefined ? project : globalRouter

    // Which preference profile this request routes through. The token
    // that authenticated the call wins when it names one — that is what
    // makes per-client routing possible — otherwise the inbound
    // surface's profile applies, which is the default for everyone.
    // Resolved before `selectModel` because the classifier below needs
    // the chain, and the chain is a property of the profile.
    const surface = await resolveSurfaceForPath(req.inboundPath)
    const surfaceProfile = surface === undefined ? undefined : surface.profileKey
    const profileKey = req.profileKeyOverride !== undefined ? req.profileKeyOverride : surfaceProfile

    // The chain is the selector. It used to be one of two, chosen by
    // ROUTER_MODE with a rollout percentage in front of it; there is no
    // second selector to roll out to any more, so the chain loads
    // unconditionally.
    //
    // The profile is loaded here rather than inside the selector because
    // classification needs it first: a scenario only wins when something
    // is configured to serve it, and the chain is that something.
    // Loading it once serves both — the selector takes the same object
    // back below.
    const chain = await loadChainRouting(true, profileKey, ctx, req.log)

    const scenarioResult = selectModel(req, tokenCount, router, ctx.config, chain?.routing)

    let model = scenarioResult.model
    let fallbacks: string[] = scenarioResult.fallbacks
    if (chain !== null) {
      const requestedModel = typeof req.body.model === 'string' ? req.body.model : undefined
      const quotaAware = await resolveQuotaAwareSelection({
        requestedModel,
        isSubagent: scenarioResult.isSubagent,
        scenario: scenarioResult.scenarioType,
        requestTokenCount: tokenCount,
        profileKey,
        profile: chain.profile
      })
      if (quotaAware.selection.primary !== null) {
        model = quotaAware.selection.primary
        fallbacks = quotaAware.selection.fallbacks
      } else if (quotaAware.retryAfterSec !== null) {
        // Phase 4: all preference candidates were gated out AND the
        // profile's `exhaustedBehavior` implied a 429 (the selector
        // returns a non-null retryAfterSec only in that case). Stamp
        // the seconds on the request so the /v1 handler can reply
        // with a rate_limit_error + Retry-After header without
        // dispatching upstream.
        req.quotaExhaustedRetryAfterSec = quotaAware.retryAfterSec
        req.log.warn(
          { retryAfterSec: quotaAware.retryAfterSec, skipped: quotaAware.selection.skipped },
          '[routing-quota-aware] preference chain exhausted — will 429'
        )
      } else {
        // Passthrough branch: no primary, no Retry-After. The
        // scenario router's answer stays in place.
        req.log.info(
          { skipped: quotaAware.selection.skipped },
          '[routing-quota-aware] no primary — falling back to scenario router'
        )
      }
    }

    // No shadow path. It existed to run the chain alongside the rules
    // selector and log where the two disagreed, which is a question with
    // one selector left to ask it of.

    // Cross-provider peer expansion runs BEFORE proactive failover so
    // both the pre-send walker and the reactive chain walker see the
    // same enriched chain. Off by default — the envelope toggle gates
    // the whole feature and returns the explicit chain unchanged.
    const enriched = applyPeerFallback(model, fallbacks, ctx)
    // Emit one info line per request that actually got peers appended so
    // an operator can audit "did the toggle fire, and to what?" without
    // reading the raw chain from the failover-walker debug logs.
    if (enriched.peerTargets.size > 0) {
      req.log.info(
        {
          primary: enriched.primary,
          peersInjected: Array.from(enriched.peerTargets),
          chainSize: enriched.fallbacks.length + 1
        },
        '[cross-provider-fallback] injected same-model peers into chain'
      )
    }

    req.body.model = applyProactiveFailover(
      enriched.primary,
      scenarioResult.scenarioType,
      enriched.fallbacks,
      tokenCount,
      ctx.config,
      req.log
    )
    req.scenarioType = scenarioResult.scenarioType
    req.isSubagent = scenarioResult.isSubagent
    req.resolvedFallbacks = enriched.fallbacks
    req.resolvedPeerTargets = enriched.peerTargets

    // Append the active persona's prompt to user-facing routes. AFTER
    // subagent-tag handling (done inside selectModel) so it composes
    // with — rather than clobbers — any per-call system content. Empty
    // is a no-op, keeping the cached prefix byte-stable.
    //
    // Gated to Anthropic-shape inbound (/v1/messages) only: persona is
    // an Anthropic-idiom convenience the Claude Code client expects,
    // and injecting it on an OpenAI-compat caller adds a stray
    // top-level `system` field the OpenAI wire format doesn't model —
    // upstreams that strictly allow-list top-level params (codex is
    // one) then reject the whole request with 400
    // `Unsupported parameter: system`. `inboundPath` is absent on the
    // pre-existing test callers that predate this hook; treat that as
    // "unknown, apply the enrichment" for backward-compat.
    if (req.inboundPath === undefined || req.inboundPath === '/v1/messages') {
      const personaPrompt = resolveActivePersonaPrompt(router, ctx.config)
      req.body.system = applyGlobalSystemPrompt(req.body.system, personaPrompt)
    }
  } catch (err) {
    req.log.error({ err }, 'scenario router failed; falling back to default model')
    // The runtime Router is the flat shape; the default agent primary is
    // the safe fallback target when routing itself threw.
    const fallback = ctx.config.get<FlatRouter>('Router')?.agent?.default
    if (typeof fallback === 'string' && fallback.length > 0) req.body.model = fallback
    req.scenarioType = 'default'
  }
}

// Counted from the request's normalised signals rather than from
// `body.messages` directly: a Responses caller carries its turns in
// `input` and a Gemini caller in `contents`, so reading the Anthropic
// key made the size-based longContext branch permanently see 0 tokens
// on those surfaces.
async function countRequestTokens(tokenizers: RouterContext['tokenizers'], tokenize: TokenizeRequest): Promise<number> {
  const result = await tokenizers.countTokens(tokenize)
  return result.tokenCount
}

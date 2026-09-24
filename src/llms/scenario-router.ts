/**
 * Request routing through the tier map.
 *
 * Reads the model the caller asked for, takes its tier (fable / opus /
 * sonnet / haiku, or "other"), and asks the tier map which provider's
 * tier should serve it — rewriting `body.model` to that target and
 * stamping the rest of the route as fallbacks. What it stamps on the
 * request — the route, the subagent flag, the fallbacks — is what the
 * failover path and the usage record read.
 *
 * The other mode is passthrough: the caller's own `body.model` reaches
 * upstream as-is. Which of the two applies is a property of the inbound
 * surface, or of the token that authenticated the call — not of this file,
 * which only asks.
 *
 * There are no scenarios or lanes any more. A request is routed by the tier
 * it asked for; size, web search and health are gates on each route, not
 * separate chains. The subagent tag is still stripped (the marker must
 * never reach upstream) and still recorded, but it no longer picks a lane.
 *
 * The file keeps its old name until the directory is renamed; the pieces
 * it uses live under `./scenario-router/` and `./tier-router/`.
 */

import { isRoutedPath, resolveSurfaceForPath } from '../services/inbound-surface-service'
import { DEFAULT_PROFILE_KEY, PASSTHROUGH_PROFILE_KEY } from '../services/tier-route-service'
import { applyGlobalSystemPrompt, resolveActivePersonaPrompt } from './scenario-router/persona'
import { stripSubagentTag } from './scenario-router/request-signals'
import { signalsOf } from './scenario-router/surface-signals'
import type { RouterContext, RouterRequest } from './scenario-router/types'
import { routeByTier } from './tier-router/runtime'
import type { TokenizeRequest } from './tokenizers/base'

export type { SubscriptionKindProvider } from './scenario-router/subscription-kind'
export { subscriptionKindOf } from './scenario-router/subscription-kind'
export type { RouterContext, RouterRequest, RouterRequestBody } from './scenario-router/types'

// The route a request that went upstream as sent is recorded under.
export const PASSTHROUGH_ROUTE = 'passthrough'

// What every exit path leaves on the request. The pipeline reads all
// three, so a branch that forgets one hands it an undefined it has to
// guess at.
type Outcome = { route: string; isSubagent: boolean; fallbacks: string[] }

function stamp(req: RouterRequest, outcome: Outcome): void {
  req.route = outcome.route
  req.isSubagent = outcome.isSubagent
  req.resolvedFallbacks = outcome.fallbacks
}

/**
 * Mutates `req.body.model` to the selected target and stamps the route,
 * the subagent flag and the fallbacks onto the request.
 *
 * Never throws, and never rewrites `body.model` to anything but a route's
 * target: when the map has nothing for this request — no routes for its
 * tier, every route switched off, the map failed to load, routing itself
 * threw — the caller's own model stays exactly as it was sent. Two
 * outcomes are handed back as fields instead, because the /v1 handler
 * answers them without dispatching: a tier whose routes are all out of
 * quota under exhaustedBehavior '429' (`quotaExhaustedRetryAfterSec`), and
 * a map that cannot take this request at all (`routingRefusal`, a 400).
 */
export async function routeRequest(req: RouterRequest, ctx: RouterContext): Promise<void> {
  // Passthrough: the caller hand-picks its target and expects that exact
  // model upstream. Which traffic that is comes from configuration: every
  // surface carries an explicit mode, and a token may name the reserved
  // passthrough profile to opt one client out.
  const forcedPassthrough = req.profileKeyOverride === PASSTHROUGH_PROFILE_KEY
  if (forcedPassthrough || !(await isRoutedPath(req.inboundPath))) {
    stamp(req, { route: PASSTHROUGH_ROUTE, isSubagent: false, fallbacks: [] })
    return
  }

  // Stripped first, and whatever happens next: the tag is a Rialto marker
  // and must never reach an upstream, including on the failure path.
  const isSubagent = stripSubagentTag(req.body.system)
  try {
    await routeThroughTierMap(req, ctx, isSubagent)
  } catch (err) {
    // The map lives in Postgres and the tokenizer is a native module;
    // either can be away. Neither is a reason to invent a target: the
    // caller's model is the only one we know it can use, so it stays.
    req.log.error({ err }, "[routing] tier routing failed; keeping the caller's own model")
    stamp(req, { route: PASSTHROUGH_ROUTE, isSubagent, fallbacks: [] })
  }

  // Append the active persona's prompt to Anthropic-shape inbound only,
  // after the tag is gone, on every routed exit path — the persona is a
  // property of the install, not of whether a route was found. Empty is a
  // no-op, keeping the cached prefix byte-stable. OpenAI-shape callers
  // get exactly what they sent: upstreams that allow-list top-level
  // params (codex) reject a stray `system`. `inboundPath` is absent on
  // test callers that predate this hook; they get the enrichment.
  if (req.inboundPath === undefined || req.inboundPath === '/v1/messages') {
    req.body.system = applyGlobalSystemPrompt(req.body.system, resolveActivePersonaPrompt(ctx.config))
  }
}

async function routeThroughTierMap(req: RouterRequest, ctx: RouterContext, isSubagent: boolean): Promise<void> {
  const signals = signalsOf(req)
  const tokenCount = await countRequestTokens(ctx.tokenizers, signals.tokenize)
  req.tokenCount = tokenCount

  // The token that authenticated the call wins when it names a profile —
  // that is what makes per-client routing possible — otherwise the
  // surface's, which is the default for everyone.
  const surface = await resolveSurfaceForPath(req.inboundPath)
  const surfaceProfile = surface === undefined ? DEFAULT_PROFILE_KEY : surface.profileKey
  const profileKey = req.profileKeyOverride !== undefined ? req.profileKeyOverride : surfaceProfile

  const requestedModel = typeof req.body.model === 'string' ? req.body.model : undefined
  const routing = await routeByTier({
    requestedModel,
    profileKey,
    requestTokenCount: tokenCount,
    needsWebSearch: signals.webSearch
  })
  const { selection } = routing

  if (selection.outcome === 'routed' && selection.primary !== null) {
    req.body.model = selection.primary
    stamp(req, { route: routing.requestedTier, isSubagent, fallbacks: selection.fallbacks })
    return
  }
  if (selection.outcome === 'exhausted' && routing.retryAfterSec !== null) {
    req.quotaExhaustedRetryAfterSec = routing.retryAfterSec
    req.log.warn(
      { requestedModel, tier: routing.requestedTier, retryAfterSec: routing.retryAfterSec, skipped: selection.skipped },
      '[routing] every route of the tier is out of quota — will 429'
    )
    stamp(req, { route: routing.requestedTier, isSubagent, fallbacks: [] })
    return
  }
  if (selection.outcome === 'refused' && selection.refusal !== null) {
    req.routingRefusal = selection.refusal
    req.log.warn({ requestedModel, tier: routing.requestedTier, skipped: selection.skipped }, '[routing] refused — will 400')
    stamp(req, { route: routing.requestedTier, isSubagent, fallbacks: [] })
    return
  }
  // No routes for the tier, every one switched off, or exhausted under
  // exhaustedBehavior 'passthrough': the caller's own model goes out.
  req.log.info(
    { requestedModel, tier: routing.requestedTier, outcome: selection.outcome, skipped: selection.skipped },
    "[routing] no route taken — keeping the caller's own model"
  )
  stamp(req, { route: PASSTHROUGH_ROUTE, isSubagent, fallbacks: [] })
}

// Counted from the request's normalised signals rather than from
// `body.messages` directly: a Responses caller carries its turns in
// `input` and a Gemini caller in `contents`.
async function countRequestTokens(tokenizers: RouterContext['tokenizers'], tokenize: TokenizeRequest): Promise<number> {
  const result = await tokenizers.countTokens(tokenize)
  return result.tokenCount
}

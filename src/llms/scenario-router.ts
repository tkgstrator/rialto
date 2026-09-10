/**
 * Chain routing.
 *
 * Reads the inbound request, classifies it into a scenario and a lane
 * (agent / subagent), and walks the preference chain for that pair to
 * rewrite `body.model` to the target the request should actually hit.
 * What it stamps on the request — the scenario, the lane, the rest of
 * the chain — is what the failover paths and the log lines read.
 *
 * The other mode is passthrough: the caller's own `body.model` reaches
 * upstream as-is. Which of the two applies is a property of the inbound
 * surface, or of the token that authenticated the call — not of this
 * file, which only asks.
 *
 * This file wires the pieces together; the pieces themselves live under
 * `./scenario-router/`: shared types, proactive failover, the
 * classifier, and persona/system-prompt injection.
 */

import type { ScenarioType } from '@/schemas/domain/scenario'
import { isRoutedPath, resolveSurfaceForPath } from '../services/inbound-surface-service'
import {
  DEFAULT_PROFILE_KEY,
  loadRoutableProfile,
  PASSTHROUGH_PROFILE_KEY
} from '../services/router-preference-service'
import { chainRoutingOf, resolveQuotaAwareSelection } from './quota-router/runtime'
import { applyProactiveFailover } from './scenario-router/failover'
import { classifyRequest } from './scenario-router/model-selection'
import { applyGlobalSystemPrompt, resolveActivePersonaPrompt } from './scenario-router/persona'
import { stripSubagentTag } from './scenario-router/request-signals'
import { signalsOf } from './scenario-router/surface-signals'
import type { ConfigProvider, RouterContext, RouterRequest } from './scenario-router/types'
import type { TokenizeRequest } from './tokenizers/base'

export type { ScenarioType } from '@/schemas/domain/scenario'
export type { SubscriptionKindProvider } from './scenario-router/failover'
export { applyProactiveFailover, candidateUsable, subscriptionKindOf } from './scenario-router/failover'
export type { ChainRouting, EffortLevel, ModelTier } from './scenario-router/model-selection'
export { classifyRequest, isHeavyRequest } from './scenario-router/model-selection'
export type { RouterContext, RouterRequest, RouterRequestBody } from './scenario-router/types'

// What every exit path leaves on the request. The pipeline reads all
// three, so a branch that forgets one hands it an undefined it has to
// guess at.
type Outcome = { scenarioType: ScenarioType; isSubagent: boolean; fallbacks: string[] }

function stamp(req: RouterRequest, outcome: Outcome): void {
  req.scenarioType = outcome.scenarioType
  req.isSubagent = outcome.isSubagent
  req.resolvedFallbacks = outcome.fallbacks
}

/**
 * Mutates `req.body.model` to the selected target and stamps the
 * scenario, lane and fallback chain onto the request.
 *
 * Never throws, and never rewrites `body.model` to anything but a chain
 * target: when the chain has nothing for this request — no entries, every
 * entry gated, the chain failed to load, routing itself threw — the
 * caller's own model stays exactly as it was sent.
 */
export async function routeScenario(req: RouterRequest, ctx: RouterContext): Promise<void> {
  // Passthrough: the caller hand-picks its target with `provider,model`
  // in body.model and expects that exact model to reach upstream. Skip
  // the whole selector, leave body.model as-is, and stamp
  // default-scenario metadata so the downstream pipeline has the fields
  // it reads.
  //
  // Which traffic that is comes from configuration: every surface
  // carries an explicit mode set from the Routing screen, and a token
  // may name the reserved passthrough profile to opt one client out
  // without changing the mode for everyone else sharing the endpoint.
  const forcedPassthrough = req.profileKeyOverride === PASSTHROUGH_PROFILE_KEY
  if (forcedPassthrough || !(await isRoutedPath(req.inboundPath))) {
    stamp(req, { scenarioType: 'default', isSubagent: false, fallbacks: [] })
    return
  }

  try {
    await routeThroughChain(req, ctx)
  } catch (err) {
    // The chain lives in Postgres and the tokenizer is a native module;
    // either can be away. Neither is a reason to invent a target: the
    // caller's model is the only one we know it can use, so it stays,
    // and the request goes out as passthrough would have sent it. The
    // tag is still stripped so the marker never reaches upstream — the
    // classifier already did so when the failure came after it.
    req.log.error({ err }, "[routing] chain routing failed; keeping the caller's own model")
    const isSubagent = req.isSubagent !== undefined ? req.isSubagent : stripSubagentTag(req.body.system)
    stamp(req, { scenarioType: 'default', isSubagent, fallbacks: [] })
  }

  // Append the active persona's prompt to user-facing routes. AFTER the
  // subagent tag has been stripped so it composes with — rather than
  // clobbers — any per-call system content, and on every routed exit
  // path, since the persona is a property of the install and not of
  // whether the chain found a primary. Empty is a no-op, keeping the
  // cached prefix byte-stable.
  //
  // Gated to Anthropic-shape inbound (/v1/messages) only: persona is an
  // Anthropic-idiom convenience the Claude Code client expects, and
  // injecting it on an OpenAI-compat caller adds a stray top-level
  // `system` field the OpenAI wire format doesn't model — upstreams that
  // strictly allow-list top-level params (codex is one) then reject the
  // whole request with 400 `Unsupported parameter: system`.
  // `inboundPath` is absent on the pre-existing test callers that
  // predate this hook; treat that as "unknown, apply the enrichment".
  if (req.inboundPath === undefined || req.inboundPath === '/v1/messages') {
    req.body.system = applyGlobalSystemPrompt(req.body.system, resolveActivePersonaPrompt(ctx.config))
  }
}

async function routeThroughChain(req: RouterRequest, ctx: RouterContext): Promise<void> {
  const tokenCount = await countRequestTokens(ctx.tokenizers, signalsOf(req).tokenize)
  req.tokenCount = tokenCount

  // Which preference profile this request routes through. The token
  // that authenticated the call wins when it names one — that is what
  // makes per-client routing possible — otherwise the inbound surface's
  // profile applies, which is the default for everyone.
  const surface = await resolveSurfaceForPath(req.inboundPath)
  const surfaceProfile = surface === undefined ? DEFAULT_PROFILE_KEY : surface.profileKey
  const profileKey = req.profileKeyOverride !== undefined ? req.profileKeyOverride : surfaceProfile

  // The profile is loaded before classification because the classifier
  // needs it first: a scenario only wins when the chain has an entry to
  // serve it. One read serves both the classifier and the selector.
  const profile = await loadRoutableProfile(profileKey)
  const providers = ctx.config.get<ConfigProvider[]>('providers', [])
  const chain = chainRoutingOf(profile, providers)

  const { scenarioType, isSubagent } = classifyRequest(req, tokenCount, chain)
  const requestedModel = typeof req.body.model === 'string' ? req.body.model : undefined
  const selected = await resolveQuotaAwareSelection({
    requestedModel,
    isSubagent,
    scenario: scenarioType,
    requestTokenCount: tokenCount,
    profileKey,
    profile
  })

  if (selected.selection.primary === null) {
    if (selected.retryAfterSec !== null) {
      // Every candidate was gated out AND the profile's
      // `exhaustedBehavior` is '429' (the selector returns a non-null
      // retryAfterSec only in that case). Stamp the seconds on the
      // request so the /v1 handler can reply with a rate_limit_error +
      // Retry-After header without dispatching upstream.
      req.quotaExhaustedRetryAfterSec = selected.retryAfterSec
      req.log.warn(
        { retryAfterSec: selected.retryAfterSec, skipped: selected.selection.skipped },
        '[routing] preference chain exhausted — will 429'
      )
    } else {
      // No primary, no Retry-After: an empty lane, or every candidate
      // gated under `exhaustedBehavior: 'passthrough'`. The caller's own
      // model stays in place and goes out with no fallbacks.
      req.log.info(
        { scenario: scenarioType, skipped: selected.selection.skipped },
        "[routing] chain has no primary — keeping the caller's own model"
      )
    }
    stamp(req, { scenarioType, isSubagent, fallbacks: [] })
    return
  }

  const fallbacks = selected.selection.fallbacks
  req.body.model = applyProactiveFailover(
    selected.selection.primary,
    scenarioType,
    fallbacks,
    tokenCount,
    ctx.config,
    req.log
  )
  stamp(req, { scenarioType, isSubagent, fallbacks })
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

/**
 * Scenario classification.
 *
 * `classifyRequest` decides which chain lane a request is asked of, in
 * two stages:
 *   1. Caller kind — a <RIALTO-SUBAGENT-MODEL> tag's PRESENCE selects the
 *      `subagent` lane; otherwise the `agent` lane. The tag's model value
 *      is not used to route; the tag is stripped either way so the marker
 *      never leaks upstream.
 *   2. Scenario — size-based longContext, web-search, thinking→think,
 *      effort/tier escalation, else default. A scenario only wins when
 *      the chain holds an enabled entry for it on the chosen lane.
 *
 * Picking the model is the selector's job (`quota-router`), not this
 * file's: it hands back a (scenario, lane) pair and nothing else.
 */

// Two modules, one per stage of the doc above: `request-signals` reads
// the wire, and this file holds the classifier.
import type { ScenarioType } from '@/schemas/domain'
import { isHeavyRequest, stripSubagentTag } from './request-signals'
import { signalsOf } from './surface-signals'
import type { RouterRequest } from './types'

// The pieces this is built from are public API in their own right — the
// quota router imports them directly. Re-exported here so
// `scenario-router/model-selection` stays the one import path.
export type { EffortLevel, ModelTier } from './request-signals'
export { isHeavyRequest, tierOf } from './request-signals'

const DEFAULT_LONG_CONTEXT_THRESHOLD = 128_000
// Fraction of the default agent target's contextWindow used as the
// effective auto-threshold. Leaves 30% headroom for the response and
// the Rialto wrapper overhead so a request landing just under the model's
// hard ceiling still fits when the reply lands.
const LONG_CONTEXT_AUTO_RATIO = 0.7

// Resolve the effective longContext threshold. The profile's configured
// threshold wins outright; when null (auto) the effective value is the
// chain's default agent target's contextWindow scaled by
// LONG_CONTEXT_AUTO_RATIO; when that is also unresolved (empty lane, no
// scraped contextWindow), fall back to the historical
// DEFAULT_LONG_CONTEXT_THRESHOLD so the classifier never sees a NaN / 0.
export function effectiveLongContextThreshold(
  manual: number | null | undefined,
  chainDefaultAgentContextWindow: number | null | undefined
): number {
  if (typeof manual === 'number' && manual > 0) return manual
  const window = chainDefaultAgentContextWindow
  if (typeof window === 'number' && window > 0) return Math.floor(window * LONG_CONTEXT_AUTO_RATIO)
  return DEFAULT_LONG_CONTEXT_THRESHOLD
}

// Which lane within a scenario a request uses: `agent` for normal /
// main-agent traffic, `subagent` when a <RIALTO-SUBAGENT-MODEL> tag is present.
export type RouteKind = 'agent' | 'subagent'

/**
 * What the preference chain can serve, as far as classification cares.
 *
 * `classifyScenario` refuses to land on a scenario nothing is configured
 * for: the selector would find no entry, return no primary, and the
 * request would drop onto the caller's own model — when the default lane
 * could have served it. Built once per request from the loaded profile
 * by `chainRoutingOf` (quota-router/runtime.ts).
 */
export interface ChainRouting {
  /** True when the chain holds at least one routable entry for this lane. */
  hasLane: (kind: RouteKind, scenario: ScenarioType) => boolean
  /**
   * Context window of the chain's top routable default/agent target, or
   * null when unknown. Feeds the auto path of
   * `effectiveLongContextThreshold` — it is the model that serves the
   * default lane, so the threshold tracks it.
   */
  defaultAgentContextWindow: number | null
  /** The profile's own `constraints.longContextThreshold`; null = auto. */
  longContextThreshold: number | null
}

export interface Classification {
  scenarioType: ScenarioType
  isSubagent: boolean
}

export function classifyRequest(req: RouterRequest, tokenCount: number, chain: ChainRouting): Classification {
  // Stage 1 — caller kind. A <RIALTO-SUBAGENT-MODEL> tag's PRESENCE selects
  // the subagent lane; its value is ignored. The tag is stripped in place
  // regardless so the Rialto-internal marker never reaches upstream.
  const isSubagent = stripSubagentTag(req.body.system)
  req.isSubagent = isSubagent
  const kind: RouteKind = isSubagent ? 'subagent' : 'agent'

  // Stage 2 — scenario classification from the request signals.
  const scenarioType = classifyScenario(req, tokenCount, kind, chain)
  return { scenarioType, isSubagent }
}

// Classify the request into a scenario. A scenario only wins when the
// chain has an entry to serve it — an unconfigured lane falls through so
// a heavy/thinking/etc. request without a matching lane lands on
// `default`.
function classifyScenario(req: RouterRequest, tokenCount: number, kind: RouteKind, chain: ChainRouting): ScenarioType {
  const threshold = effectiveLongContextThreshold(chain.longContextThreshold, chain.defaultAgentContextWindow)
  const signals = signalsOf(req)

  // Long context by size — token count exceeds threshold.
  if (tokenCount > threshold && chain.hasLane(kind, 'longContext')) {
    req.log.info(`Using long context model due to token count: ${tokenCount}, threshold: ${threshold}`)
    return 'longContext'
  }

  // Web search tools — higher priority than `thinking`. body.tools may
  // carry vendor-specific shapes (Anthropic's `{ type: 'web_search_*' }`
  // block) that TokenizeTool doesn't model.
  if (chain.hasLane(kind, 'webSearch') && signals.webSearch) {
    return 'webSearch'
  }

  // `thinking` opts into the think lane when `type` is 'enabled'
  // (explicit budget) or 'adaptive' (model decides). Claude Code
  // sends `{type: 'disabled'}` on every non-Plan-Mode request, so a
  // boolean check on `req.body.thinking` alone silently routes cheap
  // default traffic through the expensive `think` lane (Opus in most
  // configs). isThinkingEnabled excludes 'disabled' specifically.
  if (signals.thinking && chain.hasLane(kind, 'think')) {
    req.log.info({ thinking: req.body.thinking }, 'Using think model')
    return 'think'
  }

  // Effort/tier escalation — high effort or an opus-tier requested model
  // routes into the longContext (Opus) lane even when the request is
  // short enough to skip the size-based branch above.
  if (chain.hasLane(kind, 'longContext') && isHeavyRequest(req.body, signals)) {
    req.log.info({ model: req.body.model }, 'Using long context model due to heavy effort/tier signal')
    return 'longContext'
  }

  return 'default'
}

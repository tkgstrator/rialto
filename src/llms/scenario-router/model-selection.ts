/**
 * Scenario router model-selection heuristics.
 *
 * `selectModel` decides which configured model a request lands on in three
 * stages:
 *   1. Caller kind — a <RIALTO-SUBAGENT-MODEL> tag's PRESENCE selects the
 *      scenario's `subagent` route; otherwise the `agent` route. The tag's
 *      model value is not used to route; the tag is stripped either way so
 *      the marker never leaks upstream.
 *   2. Scenario classification — size-based longContext, web-search,
 *      thinking→think, effort/tier escalation, else default.
 *   3. Route lookup — walk the scenario's rule stack (first predicate
 *      match wins); when no rule matches, use the scenario's catch-all
 *      primary; when that's also unset, fall back to the request's own
 *      model. The former haiku→background branch is now expressed as a
 *      predicated rule on the `default` scenario (populated by the
 *      migration `20260728_router_rules_drop_background`).
 */

// Two modules, one per stage of the doc above: `request-signals` reads
// the wire, and this file holds the config lookup and the classifier.
// A third, `rules`, judged a predicate against the request and picked a
// target from it — the scenario router's half. It went with that
// selector.
import type { ScenarioType } from '@/schemas/domain'
import type { ConfigStore } from '../registry/config'
import { isHeavyRequest, stripSubagentTag } from './request-signals'
import { signalsOf } from './surface-signals'
import type { RouterConfig, RouterRequest } from './types'

// `selectModel` is the only entry point most callers need, but the
// pieces it is built from are public API in their own right — the quota
// router imports them directly. Re-exported here so
// `scenario-router/model-selection` stays the one import path.
export type { EffortLevel, ModelTier } from './request-signals'
export { isHeavyRequest, tierOf } from './request-signals'

const DEFAULT_LONG_CONTEXT_THRESHOLD = 128_000
// Fraction of the default agent primary's contextWindow used as the
// effective auto-threshold. Leaves 30% headroom for the response and
// the Rialto wrapper overhead so a request landing just under the model's
// hard ceiling still fits when the reply lands. Not user-configurable
// yet — flipped to a config knob once we have signal it isn't a fit.
const LONG_CONTEXT_AUTO_RATIO = 0.7

// Resolve the effective longContext threshold from the flat runtime
// router. A configured numeric threshold wins outright; when null
// (auto) the effective value is the default agent primary's
// contextWindow scaled by LONG_CONTEXT_AUTO_RATIO; when that is also
// unresolved (no default primary, no scraped contextWindow), fall back
// to the historical DEFAULT_LONG_CONTEXT_THRESHOLD so the classifier
// never sees a NaN / 0.
export function effectiveLongContextThreshold(
  router: RouterConfig | undefined,
  chainDefaultAgentContextWindow?: number | null
): number {
  const manual = router?.longContextThreshold
  if (typeof manual === 'number' && manual > 0) return manual
  // The chain's window wins over the slot's when present. It is only
  // passed when the chain is what routes, and the auto-threshold has to
  // track the model that will actually serve the default lane —
  // otherwise a chain-only install silently drops to the 128k fallback
  // no matter how large its own default model is.
  const chained = typeof chainDefaultAgentContextWindow === 'number' && chainDefaultAgentContextWindow > 0
  const window = chained ? chainDefaultAgentContextWindow : router?.defaultAgentContextWindow
  if (typeof window === 'number' && window > 0) return Math.floor(window * LONG_CONTEXT_AUTO_RATIO)
  return DEFAULT_LONG_CONTEXT_THRESHOLD
}

// Which route within a scenario a request uses: `agent` for normal /
// main-agent traffic, `subagent` when a <RIALTO-SUBAGENT-MODEL> tag is present.
export type RouteKind = 'agent' | 'subagent'

/**
 * What the preference chain can serve, as far as classification cares.
 *
 * `classifyScenario` refuses to land on a scenario nothing is configured
 * for, and "configured" used to mean exactly one thing: a RouterSlot
 * primary. That is the rules editor's half of the screen, and under the
 * chain selector it is not what routes — so an install that configured
 * only the chain classified every request as `default` and never reached
 * its own think / longContext / webSearch chains. Callers on the chain
 * path pass this so a non-empty lane counts as configuration too.
 *
 * Absent (the rules path) restores the RouterSlot-only gate exactly: in
 * that mode a chain lane really is unroutable, and classifying into one
 * would drop the request onto the caller's own model.
 */
export interface ChainRouting {
  /** True when the chain holds at least one enabled entry for this lane. */
  hasLane: (kind: RouteKind, scenario: ScenarioType) => boolean
  /**
   * Context window of the chain's top enabled default/agent target, or
   * null when unknown. Feeds `effectiveLongContextThreshold` for the same
   * reason the slot's primary does — it is the model that serves the
   * default lane.
   */
  defaultAgentContextWindow: number | null
}

export function selectModel(
  req: RouterRequest,
  tokenCount: number,
  router: RouterConfig | undefined,
  // Kept for call-site compatibility; model selection no longer resolves
  // by the request's bare model name, so the provider registry isn't read.
  _config: ConfigStore,
  // The request's chain. Absent only where no profile resolves, which
  // leaves classification on the RouterSlot map alone.
  chain?: ChainRouting
): { model: string; scenarioType: ScenarioType; isSubagent: boolean; fallbacks: string[] } {
  // Stage 1 — caller kind. A <RIALTO-SUBAGENT-MODEL> tag's PRESENCE selects
  // the subagent route; its value is ignored. The tag is stripped in place
  // regardless so the Rialto-internal marker never reaches upstream.
  const isSubagent = stripSubagentTag(req.body.system)
  req.isSubagent = isSubagent
  const kind: RouteKind = isSubagent ? 'subagent' : 'agent'

  // Stage 2 — scenario classification from the request signals.
  const scenario = classifyScenario(req, tokenCount, router, kind, chain)

  // Stage 3 — the scenario's RouterSlot target and its fallbacks. Falls
  // back to the request's own model when the slot is empty.
  const resolved = resolveTarget(router, kind, scenario)
  const model = resolved?.primary ?? req.body.model
  const fallbacks = resolved?.fallbacks ?? []
  return { model, scenarioType: scenario, isSubagent, fallbacks }
}

// The primary "provider,model" configured for a scenario on the chosen
// route kind, or undefined when unset. Reads the flat runtime maps
// (router.agent / router.subagent); null / empty read as unset.
function primaryFor(router: RouterConfig | undefined, kind: RouteKind, scenario: ScenarioType): string | undefined {
  const map = kind === 'subagent' ? router?.subagent : router?.agent
  const value = map?.[scenario]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Resolve the RouterSlot target for (scenario, kind): the slot's primary
// and its catch-all fallbacks. Undefined when the slot is empty, so
// selectModel falls back to `req.body.model` with an empty chain.
//
// There used to be a first-match rule stack in front of this, and its
// matching rule's `target` overrode the slot. Rules were the scenario
// router's half of the screen; the chain decides now, and a predicate
// stack that could still rewrite `body.model` underneath it would be a
// second selector wearing a different name.
function resolveTarget(
  router: RouterConfig | undefined,
  kind: RouteKind,
  scenario: ScenarioType
): { primary: string; fallbacks: string[] } | undefined {
  const fallbacksMap = kind === 'subagent' ? router?.subagentFallbacks : router?.agentFallbacks
  const scenarioFallbacks = fallbacksMap?.[scenario]
  const catchAllFallbacks = Array.isArray(scenarioFallbacks) ? scenarioFallbacks : []
  const scenarioPrimary = primaryFor(router, kind, scenario)
  if (scenarioPrimary === undefined) return undefined
  return { primary: scenarioPrimary, fallbacks: catchAllFallbacks }
}

// Whether anything is configured to serve (kind, scenario). A RouterSlot
// primary is one answer; under the chain selector a non-empty lane is the
// other. Either is enough — the gate exists only to keep the classifier
// off a scenario that would route nowhere, and which of the two editors
// filled it in is not the classifier's business.
function scenarioConfigured(
  router: RouterConfig | undefined,
  kind: RouteKind,
  scenario: ScenarioType,
  chain: ChainRouting | undefined
): boolean {
  if (primaryFor(router, kind, scenario) !== undefined) return true
  return chain !== undefined && chain.hasLane(kind, scenario)
}

// Classify the request into a scenario. A scenario only wins when
// something is configured to serve it — an unconfigured lane falls
// through so a heavy/haiku/etc. request without a matching route lands
// on `default` (matching the pre-refactor behaviour).
function classifyScenario(
  req: RouterRequest,
  tokenCount: number,
  router: RouterConfig | undefined,
  kind: RouteKind,
  chain: ChainRouting | undefined
): ScenarioType {
  const threshold = effectiveLongContextThreshold(router, chain?.defaultAgentContextWindow)
  const signals = signalsOf(req)

  // Long context by size — token count exceeds threshold.
  if (tokenCount > threshold && scenarioConfigured(router, kind, 'longContext', chain)) {
    req.log.info(`Using long context model due to token count: ${tokenCount}, threshold: ${threshold}`)
    return 'longContext'
  }

  // NOTE: the pre-rules haiku→background branch is gone; the same
  // behaviour is now expressed as a predicated rule on the `default`
  // scenario (see the `20260728_router_rules_drop_background` migration).
  // Rule evaluation happens in resolveTarget after this classifier runs.

  // Web search tools — higher priority than `thinking`. body.tools may
  // carry vendor-specific shapes (Anthropic's `{ type: 'web_search_*' }`
  // block) that TokenizeTool doesn't model.
  if (scenarioConfigured(router, kind, 'webSearch', chain) && signals.webSearch) {
    return 'webSearch'
  }

  // `thinking` opts into the think lane when `type` is 'enabled'
  // (explicit budget) or 'adaptive' (model decides). Claude Code
  // sends `{type: 'disabled'}` on every non-Plan-Mode request, so a
  // boolean check on `req.body.thinking` alone silently routes cheap
  // default traffic through the expensive `think` slot (Opus in most
  // configs). isThinkingEnabled excludes 'disabled' specifically.
  if (signals.thinking && scenarioConfigured(router, kind, 'think', chain)) {
    req.log.info({ thinking: req.body.thinking }, 'Using think model')
    return 'think'
  }

  // Effort/tier escalation — high effort or an opus-tier requested model
  // routes into the longContext (Opus) lane even when the request is
  // short enough to skip the size-based branch above.
  if (scenarioConfigured(router, kind, 'longContext', chain) && isHeavyRequest(req.body, signals)) {
    req.log.info({ model: req.body.model }, 'Using long context model due to heavy effort/tier signal')
    return 'longContext'
  }

  return 'default'
}

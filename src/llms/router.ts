/**
 * What happens to a request before it is dispatched.
 *
 * Rialto sends the model the caller names, so there is no routing here:
 * this strips the Rialto subagent marker, stamps the facts the failover
 * path and the usage record read (the scenario is always `passthrough`,
 * whether the request was a subagent's, the fallbacks), and appends the
 * active persona on the Anthropic surface.
 *
 * The request-shape pieces (the subagent tag, persona) live under
 * `./router/`.
 */

import { applyGlobalSystemPrompt, resolveActivePersonaPrompt } from './router/persona'
import { stripSubagentTag } from './router/request-signals'
import type { RouterContext, RouterRequest } from './router/types'

export type { SubscriptionKindProvider } from './router/subscription-kind'
export { subscriptionKindOf } from './router/subscription-kind'
export type { RouterContext, RouterRequest, RouterRequestBody } from './router/types'

// The scenario every request is recorded under: it went upstream as sent.
export const PASSTHROUGH_ROUTE = 'passthrough'

/**
 * Strips the subagent tag and stamps the route, the subagent flag and the
 * (empty) fallbacks onto the request. Never rewrites `body.model`.
 */
export function routeRequest(req: RouterRequest, ctx: RouterContext): void {
  // The tag is a Rialto marker, meaningless to any upstream, and a caller
  // that writes it into its prompts must not leak it. It is stripped
  // before anything else reads the system prompt.
  const isSubagent = stripSubagentTag(req.body.system)
  req.route = PASSTHROUGH_ROUTE
  req.isSubagent = isSubagent
  req.resolvedFallbacks = []

  // Append the active persona's prompt to Anthropic-shape inbound only,
  // after the tag is gone. Empty is a no-op, keeping the cached prefix
  // byte-stable. OpenAI-shape callers get exactly what they sent:
  // upstreams that allow-list top-level params (codex) reject a stray
  // `system`. `inboundPath` is absent on test callers that predate this
  // hook; they get the enrichment.
  if (req.inboundPath === undefined || req.inboundPath === '/v1/messages') {
    req.body.system = applyGlobalSystemPrompt(req.body.system, resolveActivePersonaPrompt(ctx.config))
  }
}

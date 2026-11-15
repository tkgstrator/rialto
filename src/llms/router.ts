/**
 * What happens to a request before it is dispatched.
 *
 * Rialto sends the model the caller names, so there is no routing here:
 * this strips the Rialto subagent marker and stamps the facts the
 * failover path and the usage record read (the scenario is always
 * `passthrough`, whether the request was a subagent's, the fallbacks).
 *
 * The request-shape pieces (the subagent tag) live under `./router/`.
 */

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
export function routeRequest(req: RouterRequest, _ctx: RouterContext): void {
  // The tag is a Rialto marker, meaningless to any upstream, and a caller
  // that writes it into its prompts must not leak it. It is stripped
  // before anything else reads the system prompt.
  const isSubagent = stripSubagentTag(req.body.system)
  req.route = PASSTHROUGH_ROUTE
  req.isSubagent = isSubagent
  req.resolvedFallbacks = []
}

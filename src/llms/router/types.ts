/**
 * Shared types for the request router.
 *
 * `ConfigProvider` is the runtime provider view the subscription-kind
 * sniffer (`subscription-kind.ts`) reads; the `Router*` types are the
 * router's public request/context shapes, re-exported from the top-level
 * `router.ts` for external callers.
 */

import type { Logger } from 'pino'
import type { ConfigStore } from '../registry/config'
import type { TokenizeMessage, TokenizeSystem, TokenizeTool } from '../tokenizers/base'

export type RouterRequestBody = {
  model: string
  messages?: TokenizeMessage[]
  system?: TokenizeSystem
  tools?: TokenizeTool[]
  metadata?: { user_id?: string }
  [extra: string]: unknown
}

export type RouterRequest = {
  body: RouterRequestBody
  reqId?: string
  log: Logger
  // Inbound wire endpoint the request arrived on (e.g. `/v1/messages`,
  // `/v1/chat/completions`, `/v1/responses`). Rialto-idiom mutations that
  // only make sense for the Anthropic client (persona injection notably)
  // gate on this: OpenAI-shape callers get the exact request they sent,
  // Anthropic-shape callers still get the enrichments Claude Code
  // expects. Absent for pre-existing test callers that predate this
  // hook — treated as "unknown, apply everything" for backward-compat.
  inboundPath?: string
  // Set by routeRequest: always 'passthrough' — the request goes upstream
  // as the caller named its model. Recorded on the RequestLog row.
  route?: string
  // True when the request carried a <RIALTO-SUBAGENT-MODEL> tag (stripped
  // before it can reach upstream). It is recorded; nothing is routed by it.
  isSubagent?: boolean
  // Set by routeRequest to [], and filled by the /v1 handler with the
  // other providers that host a bare model name, in priority order. The
  // reactive failover path (buildFailoverChain) walks this list.
  resolvedFallbacks?: string[]
}

export type RouterContext = {
  config: ConfigStore
}

export type ConfigProvider = {
  name: string
  models?: string[]
  api_base_url?: string
  // Mirrors ProviderRegistry.registerFromConfig — when this is absent or
  // empty, the registry silently skips the provider, so the router must
  // skip it too or the chain walker hits "provider not found; skipping".
  api_key?: string | null
  auth_mode?: string
  // Per-model context window (tokens), emitted by compose.ts. Used by the
  // capability gate so failover never lands on a model that cannot hold
  // the request. Absent entry = unknown window = allow (conservative).
  modelContextWindows?: Record<string, number>
}

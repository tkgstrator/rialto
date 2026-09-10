/**
 * Shared types for the scenario router split.
 *
 * `ConfigProvider` is the runtime provider view the failover walker
 * (`failover.ts`) and the chain projection (`quota-router/runtime.ts`)
 * read; the `Router*` types are the router's public request/context
 * shapes, re-exported from the top-level `scenario-router.ts` for
 * external callers.
 */

import type { Logger } from 'pino'
import type { ScenarioType } from '@/schemas/domain/scenario'
import type { ConfigStore } from '../registry/config'
import type { TokenizerRegistry } from '../registry/tokenizer'
import type { TokenizeMessage, TokenizeSystem, TokenizeTool } from '../tokenizers/base'
import type { RouterSignals } from './surface-signals'

export type RouterRequestBody = {
  model: string
  messages?: TokenizeMessage[]
  system?: TokenizeSystem
  tools?: TokenizeTool[]
  thinking?: unknown
  metadata?: { user_id?: string }
  output_config?: Record<string, unknown>
  [extra: string]: unknown
}

export type RouterRequest = {
  body: RouterRequestBody
  log: Logger
  // Inbound wire endpoint the request arrived on (e.g. `/v1/messages`,
  // `/v1/chat/completions`, `/v1/responses`). Rialto-idiom mutations that
  // only make sense for the Anthropic client (persona injection notably)
  // gate on this: OpenAI-shape callers get the exact request they sent,
  // Anthropic-shape callers still get the enrichments Claude Code
  // expects. Absent for pre-existing test callers that predate this
  // hook — treated as "unknown, apply everything" for backward-compat.
  inboundPath?: string
  // A per-client override for which RouterPreferenceProfile this request
  // routes through, from the AccessToken that authenticated it. Wins
  // over the inbound surface's own profile; absent means use the
  // surface's.
  profileKeyOverride?: string
  scenarioType?: ScenarioType
  tokenCount?: number
  // Normalised routing signals for this request, in whatever wire format
  // it arrived in. Filled lazily by `signalsOf` so a caller that builds a
  // RouterRequest by hand does not have to know about surfaces.
  signals?: RouterSignals
  // Set by the classifier: true when the request carried a
  // <RIALTO-SUBAGENT-MODEL> tag, so the chain's `subagent` lane is walked
  // instead of the `agent` lane.
  isSubagent?: boolean
  // Set by routeScenario: the rest of the chain after the primary, in
  // chain order. Both the proactive (applyProactiveFailover) and reactive
  // (buildFailoverChain) failover paths read this rather than re-deriving
  // it, so the two walk the same list.
  resolvedFallbacks?: string[]
  // Set when every candidate in the chain failed the selector's gates
  // AND the profile's `exhaustedBehavior` is '429'. The value is the
  // number of seconds until the earliest binding-window reset — the
  // caller returns a 429 with `Retry-After: <seconds>` instead of
  // dispatching upstream. Absent on the passthrough branch.
  quotaExhaustedRetryAfterSec?: number
}

export type RouterContext = {
  config: ConfigStore
  tokenizers: TokenizerRegistry
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

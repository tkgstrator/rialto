/**
 * Inbound surface registry.
 *
 * A "surface" is one wire format Rialto accepts on its front door. The
 * knowledge about a surface used to be spread over four places —
 * `errorShapeForPath`, `pickSseAggregator`, the bearer-auth path list in
 * `index.ts`, and `inboundTypeFromPath` — so adding a fifth surface meant
 * editing four files and hoping none was missed.
 *
 * This module is the single descriptor. Everything else derives from it:
 * `index.ts` mounts routes and auth from it, `error-shape.ts` picks the
 * envelope from it, `route.ts` picks the SSE aggregator from it, and
 * `route-plan.ts` resolves the endpoint transformer and the model from
 * it.
 *
 * Whether the router applies is NOT part of the descriptor. It was
 * hardcoded in `router.ts` — /v1/messages routed, the
 * OpenAI-compat surfaces bypassed — which is why every routing screen in
 * the old UI was silently a `/v1/messages`-only screen. It now lives per
 * surface in `InboundSurfaceConfig` as an explicit stored mode, so the
 * question "does routing apply here" has one answer, in one place, that
 * an operator can see and change.
 */

import {
  aggregateAnthropicSseToJson,
  aggregateGeminiSseToJson,
  aggregateOpenAiChatSseToJson,
  aggregateOpenAiResponsesSseToJson
} from '../utils/sse-aggregate'

export type SurfaceId = 'anthropic-messages' | 'openai-chat' | 'openai-responses' | 'gemini-generate'

export type RoutingMode = 'routed' | 'passthrough'

// Re-exported from the schema rather than restated. Three hand-written
// copies of this union had drifted into the tree, so adding a surface
// meant remembering all three — exactly the cost the plan's "the only
// source of a type is z.infer" rule exists to avoid.
import type { InboundType } from '@/schemas/api/request-log'

export type { InboundType }

/** Credential convention a surface's client SDK sends. */
export type SurfaceAuth = 'x-api-key' | 'bearer' | 'google'

/** Error envelope a surface's client SDK knows how to parse. */
export type SurfaceErrorShape = 'anthropic' | 'openai' | 'google'

/**
 * Fold a streaming upstream back into the surface's non-stream envelope.
 *
 * Needed whenever a provider forces `stream=true` upstream (codex-oauth
 * does) while the inbound client asked for blocking JSON.
 */
export type SseAggregator = (response: Response) => Promise<Record<string, unknown>>

export interface InboundSurface {
  id: SurfaceId
  /**
   * Display path, and the pattern `surfaceForPath` matches against. For
   * gemini this is a glob, because the real route carries the model in
   * the path (`/v1beta/models/gemini-3-pro:generateContent`).
   */
  path: string
  /**
   * Hono route pattern this surface is mounted at, which is also the
   * `endPoint` key its owning transformer declares. Identical to `path`
   * for the three `/v1` surfaces; gemini differs because a glob cannot
   * name the path segment the model lives in.
   */
  endpoint: string
  /** The client an operator most likely points at this surface. */
  client: string
  /** Wire format persisted on Session / RequestLog. */
  inboundType: InboundType
  /** Which credential header the surface authenticates with. */
  auth: SurfaceAuth
  /** Error envelope the caller's SDK knows how to parse. */
  errorShape: SurfaceErrorShape
  /** SSE→JSON fold for a non-stream caller served by a streaming upstream. */
  aggregateSse: SseAggregator
  /**
   * The model, for a surface that carries it in the URL instead of
   * `body.model`. Everything downstream — the tier router, the
   * failover chain, the pipeline — reads `body.model`, so the route
   * folds this in before any of them run.
   *
   * Absent on the surfaces whose body already carries it.
   */
  extractModel?: (path: string) => string | undefined
  /**
   * Whether the caller asked for a stream, for a surface that says so in
   * the URL instead of `body.stream`. Same reason as `extractModel`: the
   * relay decides JSON-vs-SSE from the body.
   */
  extractStream?: (path: string) => boolean
}

/**
 * Split `/v1beta/models/<model>:<action>` into its two halves.
 *
 * The model may itself contain a comma (`google,gemini-3-pro`, the form
 * Rialto uses to name a provider's model), so the split is on the LAST
 * colon — the action never contains one.
 */
function geminiPathParts(path: string): { model: string; action: string } | undefined {
  const prefix = '/v1beta/models/'
  if (!path.startsWith(prefix)) return undefined
  const segment = path.slice(prefix.length)
  const colon = segment.lastIndexOf(':')
  if (colon <= 0) return undefined
  return { model: segment.slice(0, colon), action: segment.slice(colon + 1) }
}

/**
 * What a surface's mode is set to when it has none yet.
 *
 * There is deliberately no per-surface default. The previous build
 * carried one — routed for /v1/messages, passthrough for the rest —
 * which reproduced a hardcoded bypass rather than expressing anything,
 * and it forced the UI to explain which of two identical-looking values
 * was "the shipped one". A surface now simply has a mode.
 *
 * Passthrough is the seed because routing an unconfigured install does
 * nothing useful: with no preference chain and no rules, the selector
 * falls straight through to the caller's own model. Routing is
 * something you turn on once there is something to route to.
 */
export const INITIAL_ROUTING_MODE: RoutingMode = 'passthrough'

export const INBOUND_SURFACES: readonly InboundSurface[] = [
  {
    id: 'anthropic-messages',
    path: '/v1/messages',
    endpoint: '/v1/messages',
    client: 'Claude Code',
    inboundType: 'anthropic',
    auth: 'x-api-key',
    errorShape: 'anthropic',
    aggregateSse: aggregateAnthropicSseToJson
  },
  {
    id: 'openai-chat',
    path: '/v1/chat/completions',
    endpoint: '/v1/chat/completions',
    client: 'OpenAI SDK',
    inboundType: 'openai',
    auth: 'bearer',
    errorShape: 'openai',
    aggregateSse: aggregateOpenAiChatSseToJson
  },
  {
    id: 'openai-responses',
    path: '/v1/responses',
    endpoint: '/v1/responses',
    client: 'Codex CLI',
    inboundType: 'openai',
    auth: 'bearer',
    errorShape: 'openai',
    aggregateSse: aggregateOpenAiResponsesSseToJson
  },
  {
    id: 'gemini-generate',
    path: '/v1beta/models/*',
    endpoint: '/v1beta/models/:modelAndAction',
    client: 'Gemini CLI',
    inboundType: 'gemini',
    auth: 'google',
    errorShape: 'google',
    aggregateSse: aggregateGeminiSseToJson,
    extractModel: (path) => geminiPathParts(path)?.model,
    // `:streamGenerateContent` is the only streaming action Google
    // publishes; `:generateContent` and anything else is blocking.
    extractStream: (path) => geminiPathParts(path)?.action === 'streamGenerateContent'
  }
] as const

/**
 * Paths that answer to one of the client SDKs without being a surface.
 *
 * `GET /v1/models` is a catalog read: nothing about it can be routed,
 * there is no wire type to record on RequestLog, and no routing mode
 * would mean anything. It is still an OpenAI SDK talking, though, so it
 * has to speak that SDK's auth convention and error envelope — which is
 * the only reason it appears here at all.
 */
export interface CatalogPath {
  path: string
  auth: SurfaceAuth
  errorShape: SurfaceErrorShape
}

export const CATALOG_PATHS: readonly CatalogPath[] = [
  { path: '/v1/models', auth: 'bearer', errorShape: 'openai' },
  // Anthropic's pre-flight size check. Not a completion, so not a surface —
  // but it still has to answer in the Anthropic SDK's auth convention and
  // error envelope, which is what this list carries.
  { path: '/v1/messages/count_tokens', auth: 'x-api-key', errorShape: 'anthropic' }
] as const

/**
 * Wildcard prefixes covering every surface and catalog path.
 *
 * `index.ts` mounts the access log and the proxy auth gate on these, so
 * a descriptor added under an already-covered prefix needs no edit
 * there, and one under a new prefix (a hypothetical `/v2/*`) is covered
 * the moment its descriptor lands.
 */
export const INBOUND_MOUNT_PREFIXES: readonly string[] = [
  ...new Set(
    [...INBOUND_SURFACES.map((s) => s.path), ...CATALOG_PATHS.map((p) => p.path)].map((p) => `/${p.split('/')[1]}/*`)
  )
]

const BY_ID = new Map<string, InboundSurface>(INBOUND_SURFACES.map((s) => [s.id, s]))

export function surfaceById(id: string): InboundSurface | undefined {
  return BY_ID.get(id)
}

/**
 * Resolve a concrete request path to its surface.
 *
 * Exact match, plus prefix match for a descriptor whose `path` is a
 * glob — gemini's model name and action live in the path itself. Driven
 * off the descriptor rather than a hardcoded `/v1beta/` test so a fifth
 * globbed surface resolves without editing this function.
 */
export function surfaceForPath(path: string | undefined): InboundSurface | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined
  for (const surface of INBOUND_SURFACES) {
    if (surface.path === path) return surface
    // '/v1beta/models/*' matches anything under '/v1beta/models/'.
    if (surface.path.endsWith('/*') && path.startsWith(surface.path.slice(0, -1))) return surface
  }
  return undefined
}

/** The catalog path serving this request, when it is one. */
export function catalogPathFor(path: string | undefined): CatalogPath | undefined {
  if (typeof path !== 'string' || path.length === 0) return undefined
  return CATALOG_PATHS.find((p) => p.path === path)
}

/**
 * Wire-type slug persisted on RequestLog / Session.
 *
 * Returns undefined for paths that are not a routed surface (`/v1/models`
 * is a catalog read, not a completion), so those rows stay null rather
 * than being falsely bucketed.
 */
export function inboundTypeForPath(path: string | undefined): InboundType | undefined {
  return surfaceForPath(path)?.inboundType
}

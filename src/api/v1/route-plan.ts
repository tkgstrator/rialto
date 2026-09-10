/**
 * Per-request route planning for the /v1 proxy.
 *
 * `buildRoutePlan` runs once per inbound request, before any model has
 * been chosen: it resolves the surface, parses the body, folds in
 * whatever the surface carries in the URL rather than the body, runs
 * scenario routing to land on a primary "provider,model", and bundles
 * what the chain walker needs for the rest of the request.
 *
 * The two later stages live next door, because they run per candidate
 * rather than per request:
 *   - `candidate-chain.ts`  the ordered list of models worth attempting
 *   - `invocation.ts`       one candidate → a ready-to-run invocation
 */

import type { Context } from 'hono'
import '../context'
import type { PipelineRequest } from '@/schemas/domain/pipeline'
import { RecordSchema } from '@/schemas/primitives/record'
import { type LlmsContext, type RouterRequest, routeScenario, type ScenarioType, type Transformer } from '../../llms'
import { surfaceForPath } from '../../llms/inbound/surfaces'
import { sessionIdFromRequest } from '../../llms/pipeline/session-id'
import { passthroughDenial } from '../../services/inbound-surface-service'
import { buildErrorEnvelope, errorShapeForPath } from './error-shape'

// ─── Endpoint transformer index ────────────────────────────────────────

function endpointTransformerMap(ctx: LlmsContext): Map<string, Map<string, Transformer>> {
  const map = new Map<string, Map<string, Transformer>>()
  for (const { name, transformer } of ctx.transformers.getWithEndpoint()) {
    const ep = transformer.endPoint!
    if (!map.has(ep)) map.set(ep, new Map())
    map.get(ep)!.set(name, transformer)
  }
  return map
}

// ─── Route plan shape ──────────────────────────────────────────────────

// Resolved once per inbound request, before any model is picked off the
// failover chain. routeScenario has run, so `primaryModel` is the
// "provider,model" it landed on and `scenarioType` selects the matching
// fallback chain. `routedBody` is the post-routeScenario body BEFORE
// per-model shaping (effort clamp, internal-field strip) so every chain
// attempt re-derives those from a clean copy.
export interface RoutePlan {
  routedBody: Record<string, unknown>
  headers: Record<string, string>
  transformersByName: Map<string, Transformer>
  defaultTransformer: Transformer
  scenarioType: ScenarioType
  primaryModel: string
  // The client's original body.model (pre-routing), carried through to the
  // usage-capture step so every request_logs row records "what was asked
  // for" next to "what was actually sent". Absent when the body had no
  // usable model string.
  requestedModel?: string
  // Whether the request carried a <RIALTO-SUBAGENT-MODEL> tag. Selects the
  // scenario's subagent route (vs agent) for the reactive failover chain,
  // so it matches the route selectModel used for the primary.
  isSubagent: boolean
  // Pre-resolved fallback chain: either a rule's own fallbacks (when a
  // route rule matched inside selectModel) or the scenario's catch-all
  // chain. buildFailoverChain reads this rather than re-looking-up so
  // the reactive path walks the same chain the proactive path did.
  fallbacks: readonly string[]
  // Subset of `fallbacks` auto-injected by the cross-provider peer
  // expander. buildFailoverChain reads this to bypass the same-auth_mode
  // gate on peer entries — the user opted into cross-auth-mode failover
  // when they enabled CROSS_PROVIDER_FALLBACK. Empty when the toggle
  // is off or no peers were injected.
  peerTargets: ReadonlySet<string>
  path: string
  search: string
  // The AccessToken that authenticated this request, when one did.
  // Recorded on RequestLog so Activity can attribute spend to a client.
  accessTokenId?: string
  // The key the subscription sub-account picker sticks on and the
  // reactive 429 path releases. Always a string — see
  // `resolveInboundSession` for why "no session" is not an option here.
  accountSessionKey: string
}

// ─── Build path ────────────────────────────────────────────────────────

/**
 * The session key for this request — never undefined.
 *
 * Claude Code sends `x-claude-code-session-id`; an SDK posting to
 * /v1/responses or /v1/chat/completions sends nothing of the sort, and a
 * missing key is not a neutral default here. Both consumers treat it as
 * "no session": the OAuth transformer skips `resolveAccountForSession`
 * and falls back to the provider's stored active sub-account, and
 * `tryRotateAccount` gives up before rotating. Between them, every
 * header-less client is pinned to one account and keeps hitting it after
 * it is rate-limited, while its peers sit unspent.
 *
 * The issued token is the next-best identity: stable, so a client keeps
 * its prompt-cache affinity with whichever account it drains, and
 * bounded, so the picker's in-process sticky maps cannot grow one entry
 * per request the way a random id would. Requests authenticated by the
 * envelope bootstrap key share the one anonymous bucket.
 */
function resolveInboundSession(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  tokenId: string | undefined
): string {
  const carried = sessionIdFromRequest(headers, body)
  if (carried !== undefined) return carried
  return tokenId !== undefined ? `token:${tokenId}` : 'anonymous'
}

/**
 * Fold request parameters a surface carries in the URL into the body.
 *
 * Gemini names the model and the streaming choice in the path
 * (`/v1beta/models/gemini-3-pro:streamGenerateContent`) and puts neither
 * in the body. Everything downstream — the scenario router, the failover
 * chain, the pipeline, the JSON-vs-SSE relay decision — reads
 * `body.model` and `body.stream`, so this is where the two wire
 * conventions are reconciled. A no-op for the surfaces whose body
 * already carries both.
 */
function applyPathParams(body: Record<string, unknown>, path: string): void {
  const surface = surfaceForPath(path)
  if (surface === undefined) return
  const model = surface.extractModel?.(path)
  if (model !== undefined && model.length > 0) body.model = model
  const stream = surface.extractStream?.(path)
  if (stream !== undefined) body.stream = stream
}

export async function buildRoutePlan(c: Context, ctx: LlmsContext): Promise<Response | RoutePlan> {
  const url = new URL(c.req.url)
  const path = url.pathname
  const shape = errorShapeForPath(path)

  // The transformer is registered under the surface's endpoint pattern,
  // which is not the request path when the surface carries the model in
  // it — `/v1beta/models/gemini-3-pro:generateContent` is served by the
  // transformer registered at `/v1beta/models/:modelAndAction`.
  const surface = surfaceForPath(path)
  const endpointKey = surface !== undefined ? surface.endpoint : path
  const transformersByName = endpointTransformerMap(ctx).get(endpointKey)
  if (!transformersByName) {
    return c.json(buildErrorEnvelope({ shape, status: 404, from: `No handler for ${path}` }), 404)
  }
  // First registered transformer at this endpoint; resolveInvocationForModel
  // may swap it per-model if the routed-to provider has a bypass single-use.
  const defaultTransformer: Transformer = transformersByName.values().next().value!

  // Set by the /v1 auth middleware when an issued token authenticated
  // the call. Absent for the envelope bootstrap token.
  const token = c.get('accessToken')
  const tokenId = token?.id

  const bodyParsed = RecordSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!bodyParsed.success) {
    return c.json(buildErrorEnvelope({ shape, status: 400, from: 'Request body must be a JSON object' }), 400)
  }
  const body = bodyParsed.data
  applyPathParams(body, path)
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v
  })

  // Capture what the client asked for BEFORE routeScenario rewrites
  // body.model in place — this is the only point the original is visible.
  const requestedModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined

  // Scenario routing: rewrite body.model to the resolved provider,model
  // and stamp req.scenarioType. We keep the request object so we can read
  // the scenario back — it selects the failover chain below.
  const routeReq: RouterRequest = {
    body: body as PipelineRequest['body'] & { model: string },
    log: ctx.log,
    sessionId: undefined,
    // The scenario router uses this to gate Anthropic-idiom mutations
    // (persona injection etc.) so OpenAI-compat callers on
    // /v1/chat/completions and /v1/responses get the exact request
    // they sent rather than one enriched for Claude Code.
    inboundPath: path,
    // A token may pin its client to a named preference chain, which
    // then wins over the surface's own profile. This is the point of
    // per-client tokens: a CI runner on cost-first while interactive
    // traffic keeps the default.
    profileKeyOverride: token?.profileKey === null ? undefined : token?.profileKey
  }
  await routeScenario(routeReq, { config: ctx.config, tokenizers: ctx.tokenizers })
  const scenarioType: ScenarioType = routeReq.scenarioType !== undefined ? routeReq.scenarioType : 'default'

  // Phase 4: quota-aware selector exhausted all candidates and the
  // profile's `exhaustedBehavior` is '429'. Return the rate-limit
  // response verbatim so no upstream dispatch happens. `Retry-After`
  // carries the seconds until the earliest binding-window reset.
  const retryAfter = routeReq.quotaExhaustedRetryAfterSec
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return new Response(
      JSON.stringify(
        buildErrorEnvelope({
          shape,
          status: 429,
          from: 'Preference chain exhausted; retry after the window resets.'
        })
      ),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': String(retryAfter) }
      }
    )
  }

  // A passthrough surface can refuse a target. The check lives here and
  // not in `routeScenario` because that function never throws — it
  // catches everything and falls back, so a rejection raised inside it
  // would be swallowed and the request would go upstream anyway. Here we
  // still have the inbound path and the client's error shape, which is
  // what a refusal has to answer in.
  //
  // It runs after routeScenario on purpose: in routed mode body.model is
  // no longer the caller's string, and `passthroughDenial` returns
  // undefined for routed surfaces rather than judging a value the chain
  // already replaced.
  const denial = await passthroughDenial(path, typeof body.model === 'string' ? body.model : undefined)
  if (denial !== undefined) {
    return c.json(buildErrorEnvelope({ shape, status: 400, from: denial }), 400)
  }

  const primaryModel = typeof body.model === 'string' ? body.model : ''
  if (primaryModel.length === 0) {
    return c.json(buildErrorEnvelope({ shape, status: 400, from: 'Missing model in request body' }), 400)
  }

  return {
    routedBody: body,
    headers,
    accountSessionKey: resolveInboundSession(headers, body, tokenId),
    transformersByName,
    defaultTransformer,
    scenarioType,
    primaryModel,
    requestedModel,
    isSubagent: routeReq.isSubagent === true,
    // The fallback chain selectModel resolved for this request — a rule's
    // own chain when a route rule fired, otherwise the scenario's
    // catch-all. buildFailoverChain reads this directly so the reactive
    // path walks the same chain the proactive path did.
    fallbacks: Array.isArray(routeReq.resolvedFallbacks) ? routeReq.resolvedFallbacks : [],
    peerTargets: routeReq.resolvedPeerTargets ?? new Set<string>(),
    path,
    search: url.search,
    accessTokenId: tokenId
  }
}

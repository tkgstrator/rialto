/**
 * Per-request route planning for the /v1 proxy.
 *
 * `buildRoutePlan` runs once per inbound request, before any model has
 * been chosen: it resolves the surface, parses the body, folds in
 * whatever the surface carries in the URL rather than the body, applies
 * the token's plan to the model, resolves a bare model name to its
 * provider, and bundles what the chain walker needs for the rest of the
 * request.
 *
 * The two later stages live next door, because they run per candidate
 * rather than per request:
 *   - `candidate-chain.ts`  the ordered list of models worth attempting
 *   - `invocation.ts`       one candidate → a ready-to-run invocation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import '../context'
import type { PipelineRequest } from '@/schemas/domain/pipeline'
import { RecordSchema } from '@/schemas/primitives/record'
import { type LlmsContext, PASSTHROUGH_ROUTE, type RouterRequest, routeRequest, type Transformer } from '../../llms'
import { surfaceForPath } from '../../llms/inbound/surfaces'
import { type ClassifierSignals, classifierSignals } from '../../llms/pipeline/classifier-diagnostics'
import { sessionIdFromRequest } from '../../llms/pipeline/session-id'
import { archiveRequest, requestArchiveEnabled } from '../../llms/request-archive'
import type { TokenPlan } from '../../services/access-token-service'
import { passthroughDenial } from '../../services/inbound-surface-service'
import { preferredProviderOrder } from '../../services/model-provider-preference'
import { decidePlanModel } from '../../services/plan-model'
import { qualifiedModelId } from '../../shared/public-model-id'
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
// failover chain. `primaryModel` is the model the request goes to after the
// plan and provider-priority resolution. `routedBody` is the post-
// routeRequest body BEFORE per-model shaping (effort clamp, internal-field
// strip) so every chain attempt re-derives those from a clean copy.
export interface RoutePlan {
  reqId?: string
  routedBody: Record<string, unknown>
  headers: Record<string, string>
  transformersByName: Map<string, Transformer>
  defaultTransformer: Transformer
  // Always 'passthrough' now; recorded on the RequestLog row's `scenario`
  // column, which older rows fill with the retired scenario names.
  route: string
  primaryModel: string
  // The client's original body.model (pre-routing), carried through to the
  // usage-capture step so every request_logs row records "what was asked
  // for" next to "what was actually sent". Absent when the body had no
  // usable model string.
  requestedModel?: string
  classifierSignals?: ClassifierSignals
  // Whether the request carried a <RIALTO-SUBAGENT-MODEL> tag. Recorded on
  // the request log so Activity can tell subagent traffic apart.
  isSubagent: boolean
  // The other providers hosting a bare model name, in priority order; empty
  // when the request named `provider,model`. buildFailoverChain walks it
  // after the primary.
  fallbacks: readonly string[]
  path: string
  search: string
  // The AccessToken that authenticated this request, when one did.
  // Recorded on RequestLog so Activity can attribute spend to a client.
  accessTokenId?: string
  // The surface to record in place of the one the path names. Set only
  // by an in-process caller (the Codex MCP server) through the context.
  surfaceOverride?: PipelineRequest['surface']
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
 * per request the way a random id would. A call with no token id shares
 * the one anonymous bucket.
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
 * in the body. Everything downstream — the plan check, the failover
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

// An allowed bare name with multiple hosts stays bare until provider
// priority resolves it here, restricted to the providers the plan lists.
async function bareModelProviders(model: string, ctx: LlmsContext, plan: TokenPlan | null | undefined) {
  const hosts = ctx.providers
    .getAll()
    .filter((provider) => Array.isArray(provider.models) && provider.models.includes(model))
    .map((provider) => provider.name)
  const allowed =
    plan === null || plan === undefined
      ? undefined
      : plan.models.flatMap((entry) => {
          const comma = entry.indexOf(',')
          return comma > 0 && entry.slice(comma + 1) === model ? [entry.slice(0, comma)] : []
        })
  return preferredProviderOrder(model, hosts, allowed)
}

export async function buildRoutePlan(c: Context, ctx: LlmsContext): Promise<Response | RoutePlan> {
  const reqId = randomUUID()
  const requestLog = ctx.log.child({ reqId })
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

  // Capture what the client asked for BEFORE the plan may rewrite
  // body.model in place — this is the only point the original is visible.
  const requestedModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined
  const signals = path === '/v1/messages' ? classifierSignals(body) : undefined
  const diagnosticLog = (status: number, reason: string): void => {
    if (!signals || (!signals.safeguardsPresent && !signals.suspectedClassifier)) return
    ctx.log.info(
      { event: 'classifier_diagnostic', phase: 'routing_refusal', ...signals, status, reason, requestedModel },
      'classifier diagnostic: request stopped before upstream'
    )
  }

  // A token on a plan may only spend the plan's models. One it names is
  // kept; naming none sends the request to the plan's default; naming one
  // the plan does not list is refused with 403 rather than redirected, so a
  // stale client setting surfaces instead of being served by a model the
  // caller never asked for. Decided after `requestedModel` is captured, so
  // the log still shows what the client asked for next to what was sent.
  const decision = decidePlanModel(token?.plan, requestedModel)
  if (decision.kind === 'denied') {
    diagnosticLog(403, 'plan_model_denied')
    return c.json(buildErrorEnvelope({ shape, status: 403, from: decision.message }), 403)
  }
  if (decision.kind === 'allowed' || decision.kind === 'default') body.model = decision.model

  // Before routeRequest strips the subagent tag in place.
  const archivedBody = requestArchiveEnabled() ? structuredClone(body) : undefined

  // Stamps the subagent flag, strips its tag and injects the persona; the
  // request object is kept so the flag and the fallbacks can be read back.
  const routeReq: RouterRequest = {
    body: body as PipelineRequest['body'] & { model: string },
    log: requestLog,
    reqId,
    // The router uses this to gate Anthropic-idiom mutations
    // (persona injection etc.) so OpenAI-compat callers on
    // /v1/chat/completions and /v1/responses get the exact request
    // they sent rather than one enriched for Claude Code.
    inboundPath: path
  }
  routeRequest(routeReq, { config: ctx.config })
  const route = PASSTHROUGH_ROUTE
  if (archivedBody !== undefined) {
    void archiveRequest({
      reqId,
      sessionId: sessionIdFromRequest(headers, archivedBody),
      path,
      headers,
      body: archivedBody,
      requestedModel,
      routedModel: body.model,
      route,
      isSubagent: routeReq.isSubagent
    })
  }

  // A bare name is a public model id. Resolve the provider here, before deny
  // rules and the failover walker, so both judge the same target.
  const bareModel = typeof body.model === 'string' && !body.model.includes(',') ? body.model : undefined
  if (bareModel !== undefined && bareModel.length > 0) {
    const order = await bareModelProviders(bareModel, ctx, token?.plan)
    if (order.status === 'ambiguous') {
      diagnosticLog(400, 'model_provider_ambiguous')
      return c.json(
        buildErrorEnvelope({
          shape,
          status: 400,
          from: `Model "${bareModel}" has multiple providers; configure their priority in Providers → Models.`
        }),
        400
      )
    }
    if (order.status === 'preferred') {
      body.model = qualifiedModelId({ provider: order.providers[0], model: bareModel })
      routeReq.resolvedFallbacks = order.providers
        .slice(1)
        .map((provider) => qualifiedModelId({ provider, model: bareModel }))
    }
  }

  // A surface can refuse a target. The check lives here, where the inbound
  // path and the client's error shape are at hand, which is what a refusal
  // has to answer in.
  const denial = await passthroughDenial(path, typeof body.model === 'string' ? body.model : undefined)
  if (denial !== undefined) {
    diagnosticLog(400, 'passthrough_denial')
    return c.json(buildErrorEnvelope({ shape, status: 400, from: denial }), 400)
  }
  if (routeReq.resolvedFallbacks !== undefined) {
    const checked = await Promise.all(
      routeReq.resolvedFallbacks.map(async (target) => ({
        target,
        denied: await passthroughDenial(path, target)
      }))
    )
    routeReq.resolvedFallbacks = checked.filter((entry) => entry.denied === undefined).map((entry) => entry.target)
  }

  const primaryModel = typeof body.model === 'string' ? body.model : ''
  if (primaryModel.length === 0) {
    diagnosticLog(400, 'missing_model')
    return c.json(buildErrorEnvelope({ shape, status: 400, from: 'Missing model in request body' }), 400)
  }

  return {
    reqId,
    routedBody: body,
    headers,
    accountSessionKey: resolveInboundSession(headers, body, tokenId),
    transformersByName,
    defaultTransformer,
    route,
    primaryModel,
    requestedModel,
    classifierSignals: signals ?? { safeguardsPresent: false, suspectedClassifier: false },
    isSubagent: routeReq.isSubagent === true,
    // The other providers hosting a bare model name, in priority order.
    // buildFailoverChain reads this directly so the reactive path walks
    // exactly the providers that were resolved here.
    fallbacks: Array.isArray(routeReq.resolvedFallbacks) ? routeReq.resolvedFallbacks : [],
    path,
    search: url.search,
    accessTokenId: tokenId,
    surfaceOverride: c.get('surfaceOverride')
  }
}

/**
 * One chain candidate → one ready-to-run invocation.
 *
 * `resolveInvocationForModel` takes a "provider,model" string off the
 * candidate chain and produces the `ResolvedInvocation` the pipeline
 * runs: body + headers + provider + transformer, with per-model shaping
 * applied — effort clamping, Rialto-internal field strip, subscription
 * beta-header reshape — on a fresh copy, so nothing leaks between chain
 * attempts and the route plan itself is never mutated.
 *
 * The stages either side of this one:
 *   - `route-plan.ts`      per-request planning, runs once
 *   - `candidate-chain.ts` which models are worth attempting, in order
 */

import type { PipelineRequest } from '@/schemas/domain/pipeline'
import type { LlmsContext, ResolvedProvider, Transformer } from '../../llms'
import { inboundTypeForPath, surfaceForPath } from '../../llms/inbound/surfaces'
import { isLongContextDenied } from '../../services/failover-state'
import { getActiveAccountForSession } from '../../services/session-account-router'
import type { RoutePlan } from './route-plan'
import { prepareSubscriptionBetas } from './subscription-betas'

// ─── Reasoning-effort normalisation ────────────────────────────────────

// Per-model max-supported effort. Claude Code sends body.output_config.effort
// (e.g. 'xhigh'); models that don't support a level — or `effort` at all
// — 400. Normalise BEFORE sending. Ordered low→high so the last entry is
// the model's max supported level.
const EFFORT_BY_MODEL: Record<string, readonly string[]> = {
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-5': ['low', 'medium', 'high']
}

function effortSetFor(model: string): readonly string[] | undefined {
  for (const id of Object.keys(EFFORT_BY_MODEL)) {
    if (model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}@`)) return EFFORT_BY_MODEL[id]
  }
  return undefined
}

function normalizeEffort(body: Record<string, unknown>, model: string): void {
  const oc = body.output_config as { effort?: unknown } | undefined
  const requested = oc?.effort
  if (typeof requested !== 'string') return
  const allowed = effortSetFor(model)
  if (!allowed) {
    delete oc!.effort
    return
  }
  if (!allowed.includes(requested)) oc!.effort = allowed[allowed.length - 1]
}

// ─── Anthropic subscription beta header reshape ────────────────────────

// Resolve whether the target this request is about to hit has already
// been refused the long-context entitlement. The sticky session→account
// map is consulted so the answer is account-scoped whenever the pipeline
// has picked one; a session that has not resolved an account yet falls
// back to the coarser provider-level mark.
function longContextDeniedFor(sessionId: string, providerName: string): boolean {
  return isLongContextDenied(providerName, getActiveAccountForSession(sessionId))
}

// ─── Resolved invocation shape ─────────────────────────────────────────

// A single model's fully-resolved invocation, ready for the pipeline.
export interface ResolvedInvocation {
  body: Record<string, unknown>
  headers: Record<string, string>
  request: PipelineRequest
  provider: ResolvedProvider
  transformer: Transformer
}

// Resolve a bare model name (no "provider," prefix) by scanning the
// provider registry for a provider that lists this model. Returns the
// provider name on a unique match, null when the model is unknown, or
// null with a warning when multiple providers host it (ambiguous —
// can't pick without operator intent). Callers use this to pass a
// bare-model request through to the sole hosting provider when the
// scenario router had no primary configured for the request.
function providerHostingModel(ctx: LlmsContext, bareModel: string): string | null {
  const hosts: string[] = []
  for (const p of ctx.providers.getAll()) {
    if (Array.isArray(p.models) && p.models.includes(bareModel)) hosts.push(p.name)
  }
  if (hosts.length === 0) return null
  if (hosts.length > 1) {
    ctx.log.warn({ model: bareModel, hosts }, 'passthrough: bare model is ambiguous across providers; skipping')
    return null
  }
  return hosts[0]
}

// Resolve one "provider,model" string into a ready-to-run invocation, or
// null when the model can't be used (malformed string / unknown
// provider) — the caller skips a null and moves to the next chain entry.
export function resolveInvocationForModel(
  plan: RoutePlan,
  modelString: string,
  ctx: LlmsContext
): ResolvedInvocation | null {
  const target = splitModelString(modelString, ctx)
  if (target === null) return null
  const { providerName, model } = target

  const provider = ctx.providers.get(providerName)
  if (!provider) {
    ctx.log.warn({ providerName }, 'failover: provider not found; skipping')
    return null
  }

  // Fresh per-attempt body / headers so per-model shaping (effort clamp,
  // internal-field strip, subscription beta reshape) never leaks across
  // chain attempts.
  const body: Record<string, unknown> = { ...plan.routedBody }
  const headers: Record<string, string> = { ...plan.headers }
  body.model = model

  // Clamp / strip output_config.effort to what the routed-to model
  // supports — BEFORE the upstream call.
  normalizeEffort(body, model)

  // Consume and remove Rialto-internal extensions that Claude Code adds
  // for Rialto-specific features (context management, diagnostics, effort
  // tuning). These must not reach any upstream provider API.
  delete body.context_management
  delete body.output_config
  delete body.diagnostics

  // Bypass detection: if the provider has a single transformer that
  // matches the endpoint's path, use it instead of the default at this
  // endpoint. (Same logic the legacy registerApiRoutes used.)
  const soleUseName = provider.transformer?.use?.length === 1 ? provider.transformer.use[0].name : undefined
  const swapped =
    soleUseName && plan.transformersByName.has(soleUseName) ? plan.transformersByName.get(soleUseName) : undefined
  const transformer: Transformer = swapped !== undefined ? swapped : plan.defaultTransformer

  // Subscription path: subscriptions route through *-oauth transformers.
  // Reshape the anthropic-beta header (add oauth beta; drop context-1m
  // only when this provider/account is known to lack the entitlement).
  if (typeof soleUseName === 'string' && soleUseName.endsWith('-oauth')) {
    prepareSubscriptionBetas(headers, longContextDeniedFor(plan.accountSessionKey, providerName))
  }

  const request: PipelineRequest = {
    body,
    headers,
    url: plan.path + plan.search,
    provider: providerName,
    model,
    scenarioType: plan.scenarioType,
    requestedModel: plan.requestedModel,
    isSubagent: plan.isSubagent,
    inboundType: inboundTypeForPath(plan.path),
    surface: surfaceForPath(plan.path)?.id,
    accessTokenId: plan.accessTokenId,
    accountSessionKey: plan.accountSessionKey
  }

  return { body, headers, request, provider, transformer }
}

/**
 * Split a chain entry into provider + model.
 *
 * A bare model (no "provider," prefix) means the scenario router had no
 * primary configured and left `body.model` untouched, so the chain
 * carries the raw name the client asked for. A unique host in the
 * registry acts as the pass-through target; ambiguous or unknown names
 * are skipped by the caller.
 */
function splitModelString(modelString: string, ctx: LlmsContext): { providerName: string; model: string } | null {
  const commaIdx = modelString.indexOf(',')
  if (commaIdx > 0) {
    return { providerName: modelString.slice(0, commaIdx), model: modelString.slice(commaIdx + 1) }
  }
  const host = providerHostingModel(ctx, modelString)
  if (host === null || modelString.length === 0) {
    ctx.log.warn({ modelString }, 'failover: malformed provider,model; skipping')
    return null
  }
  ctx.log.info({ model: modelString, provider: host }, 'passthrough: bare model resolved to provider')
  return { providerName: host, model: modelString }
}

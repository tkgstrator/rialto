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
import { hasSafeguards } from '../../llms/pipeline/classifier-diagnostics'
import { shouldBypass } from '../../llms/pipeline/request-chain'
import { isLongContextDenied } from '../../services/failover-state'
import { getActiveAccountForSession } from '../../services/session-account-router'
import type { RoutePlan } from './route-plan'
import { prepareSubscriptionBetas } from './subscription-betas'

// ─── Claude Code effort normalisation ────────────────────────────────

// The effort to send in place of `requested`, given what the model's own
// list reported: the highest supported level at or below it. Undefined
// when the model takes no effort at all (Haiku 4.5 refuses the field).
function clampedEffort(requested: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined
  if (supported.includes(requested)) return requested
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max']
  const rank = ladder.indexOf(requested)
  if (rank < 0) return requested
  const replacement = supported.filter((level) => ladder.indexOf(level) <= rank).at(-1)
  return replacement === undefined ? requested : replacement
}

// `supported` is what the model's own list reported (ModelCapability);
// undefined until recorded, which leaves the caller's effort as sent.
function normalizeClaudeCodeEffort(body: Record<string, unknown>, supported: readonly string[] | undefined): void {
  const output = body.output_config
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return
  const config = { ...output }
  const requested = Reflect.get(config, 'effort')
  if (typeof requested === 'string' && supported !== undefined) {
    const effort = clampedEffort(requested, supported)
    if (effort === undefined) Reflect.deleteProperty(config, 'effort')
    else Reflect.set(config, 'effort', effort)
  }
  body.output_config = config
}

function preserveMessagesFormat(body: Record<string, unknown>, path: string): void {
  const output = body.output_config
  if (path === '/v1/messages' && output !== null && typeof output === 'object' && 'format' in output) {
    body.output_config = { format: output.format }
  } else delete body.output_config
}

function safeguardsCompatible(
  path: string,
  body: Record<string, unknown>,
  provider: ResolvedProvider,
  transformer: Transformer
): boolean {
  // The tier router has no safeguards capability gate. Only the native
  // Messages bypass is known to preserve this Anthropic-only contract;
  // conversion must not turn a permission check into ordinary generation.
  if (path !== '/v1/messages' || !hasSafeguards(body)) return true
  const nativeMessages = transformer.name === 'anthropic' || transformer.name === 'claude-code-oauth'
  return nativeMessages && shouldBypass(provider.transformer, transformer, body)
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

function hasClientEffort(body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning
  const thinking = body.thinking
  const output = body.output_config
  return (
    'reasoning_effort' in body ||
    (reasoning !== null && typeof reasoning === 'object' && 'effort' in reasoning) ||
    (thinking !== null && typeof thinking === 'object' && ('budget_tokens' in thinking || 'type' in thinking)) ||
    (output !== null && typeof output === 'object' && 'effort' in output)
  )
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
// chain had no primary for the request. The registry lists only
// enabled models of enabled providers, so a switched-off model never
// hosts anything here.
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
// null when the model can't be used (malformed string / unknown or
// disabled provider / unknown or disabled model) — the caller skips a
// null and moves to the next chain entry.
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

  // The registry carries only the models the operator has switched on,
  // so a pair outside it is a model that is off (or was never
  // registered). Refusing it here is what makes the Providers screen's
  // toggle mean the same thing to a passthrough caller naming the pair
  // by hand as it does to the chain — and `/v1/models` advertises the
  // same set, so the menu and the door agree.
  if (!Array.isArray(provider.models) || !provider.models.includes(model)) {
    ctx.log.warn({ providerName, model }, 'failover: model is not enabled on this provider; skipping')
    return null
  }

  // Fresh per-attempt body / headers so per-model shaping (effort clamp,
  // internal-field strip, subscription beta reshape) never leaks across
  // chain attempts.
  const clientSpecifiedEffort = hasClientEffort(plan.routedBody)
  const body: Record<string, unknown> = { ...plan.routedBody }
  const headers: Record<string, string> = { ...plan.headers }
  body.model = model

  // Effort remains subscription-specific here, but the format must reach
  // the inbound transformer even when routing Messages to another vendor.
  const claudeCode = provider.transformer?.use?.some((step) => step.name === 'claude-code-oauth') === true
  if (claudeCode) normalizeClaudeCodeEffort(body, provider.modelSupportedEfforts?.[model])
  else preserveMessagesFormat(body, plan.path)

  // Consume Rialto-internal extensions before any upstream dispatch.
  delete body.context_management
  delete body.diagnostics

  // Bypass detection: if the provider has a single transformer that
  // matches the endpoint's path, use it instead of the default at this
  // endpoint. (Same logic the legacy registerApiRoutes used.)
  const soleUseName = provider.transformer?.use?.length === 1 ? provider.transformer.use[0].name : undefined
  const swapped =
    soleUseName && plan.transformersByName.has(soleUseName) ? plan.transformersByName.get(soleUseName) : undefined
  const transformer: Transformer = swapped !== undefined ? swapped : plan.defaultTransformer

  // Check every attempt, including fallbacks, before any upstream dispatch.
  if (!safeguardsCompatible(plan.path, body, provider, transformer)) {
    ctx.log.warn(
      {
        event: 'provider_compatibility_skip',
        reason: 'anthropic_safeguards',
        provider: providerName,
        model,
        route: plan.route
      },
      'safeguards requires native Messages; skipping incompatible configured candidate'
    )
    return null
  }

  // Subscription path: subscriptions route through *-oauth transformers.
  // Reshape the anthropic-beta header (add oauth beta; drop context-1m
  // only when this provider/account is known to lack the entitlement).
  if (typeof soleUseName === 'string' && soleUseName.endsWith('-oauth')) {
    prepareSubscriptionBetas(headers, longContextDeniedFor(plan.accountSessionKey, providerName))
  }

  // The first selector candidate wins when several tier aliases share a target,
  // matching the chain's target deduplication rather than guessing from a model id.
  const selected = plan.selectedRoutes?.find((entry) => entry.target === `${providerName},${model}`)
  const request: PipelineRequest = {
    reqId: plan.reqId,
    selectedTier: selected?.targetTier,
    selectedRoute: selected?.route,
    body,
    headers,
    url: plan.path + plan.search,
    provider: providerName,
    model,
    route: plan.route,
    requestedModel: plan.requestedModel,
    classifierSignals: plan.classifierSignals,
    isSubagent: plan.isSubagent,
    inboundType: inboundTypeForPath(plan.path),
    surface: plan.surfaceOverride !== undefined ? plan.surfaceOverride : surfaceForPath(plan.path)?.id,
    accessTokenId: plan.accessTokenId,
    accountSessionKey: plan.accountSessionKey,
    clientEffortIntent: clientSpecifiedEffort ? 'explicit' : 'unspecified'
  }

  return { body, headers, request, provider, transformer }
}

/**
 * Split a chain entry into provider + model.
 *
 * A bare model (no "provider," prefix) means the chain had no primary
 * for this request and left `body.model` untouched, so the chain
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

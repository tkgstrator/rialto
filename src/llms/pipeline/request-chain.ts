/**
 * Request-side transformer chain.
 *
 * Detects bypass mode (single matching transformer, no real chain to
 * run) and, when not bypassed, runs the endpoint transformer's
 * `transformRequestOut` followed by the provider- and model-level
 * `transformRequestIn` chains.
 */

import {
  isProviderModelBlock,
  isTransformerHookResult,
  type TransformerConfig,
  type UnifiedChatRequest,
  viewPipelineBody
} from '@/schemas/domain'
import type { ResolvedProviderTransformer } from '../registry/provider'
import type { Transformer } from '../transformers/base'
import type { PipelineInput } from './types'

// Inbound headers that MUST NOT reach the upstream provider on the
// bypass path. Buckets:
//
//  Hop-by-hop / encoding — content-length is re-serialised by
//  fetchProvider; accept-encoding is stripped because Rialto's fetch
//  auto-decompresses, and forwarding the inbound value causes the
//  upstream to send a compressed body that Bun decompresses while its
//  content-encoding header lingers, which triggers a double-decompress
//  ZlibError on the Claude Code client side.
//
//  Client-auth — authorization / x-api-key / x-goog-api-key carry the
//  client's Rialto access token. Forwarding them causes the upstream to
//  see the Rialto token as its own credential instead of
//  provider.api_key; buildRequestHeaders sets the correct provider
//  Bearer first, but a lowercase inbound `authorization` spread on top
//  overrides it and OpenAI then 400s with "Incorrect API key".
//  `x-goog-api-key` is the Gemini surface's convention and is stripped
//  for the same reason — the gemini transformer's auth hook overwrites
//  it on the way out, but a client token must not depend on one hook
//  remembering to.
//
//  Proxy trail — host and every Cloudflare / X-Forwarded-* header the
//  front tier stamps on the request. Two failure modes drove the wider
//  strip:
//    - `Host: llm.tkgstrator.work` (the inbound Host) survives the
//      spread and reaches api.openai.com, which SNI-routes on Host —
//      the mismatch alone earns a 403.
//    - `cf-*` / `cdn-loop: cloudflare` on requests hitting another
//      Cloudflare-fronted upstream trip CF's loop / replay detection
//      and get returned as 403 Forbidden from cloudflare (HTML), not
//      the vendor's own error body.
//  Model test's probeInference builds its own tiny header set so it
//  never had these; the pipeline's bypass path did, and that is why
//  "test passes, real request 403s" showed up only against remote Rialtos
//  behind a Cloudflare front (local dev is direct, so cf-* is absent
//  and the same bug never fired).
const STRIP_INBOUND_EXACT = new Set([
  'content-length',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'host',
  'x-real-ip',
  'cdn-loop',
  'forwarded',
  'via'
])
const STRIP_INBOUND_PREFIXES = ['cf-', 'x-forwarded-']

export function shouldStripInboundHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (STRIP_INBOUND_EXACT.has(lower)) return true
  for (const prefix of STRIP_INBOUND_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }
  return false
}

function withoutClientBillingMarker(body: Record<string, unknown>): Record<string, unknown> {
  const system = body.system
  if (!Array.isArray(system) || system.length === 0) return body
  const first: unknown = system[0]
  if (first === null || typeof first !== 'object' || !('text' in first)) return body
  if (typeof first.text !== 'string' || !first.text.startsWith('x-anthropic-billing-header:')) return body
  const outbound = { ...body }
  const rest = system.slice(1)
  if (rest.length === 0) delete outbound.system
  else outbound.system = rest
  return outbound
}

export function shouldBypass(
  providerTx: ResolvedProviderTransformer | undefined,
  transformer: Transformer,
  body: Record<string, unknown>
): boolean {
  const topUse = providerTx?.use
  if (!Array.isArray(topUse) || topUse.length !== 1 || topUse[0].name !== transformer.name) return false
  const modelBlock = lookupProviderModelBlock(providerTx, typeof body.model === 'string' ? body.model : '')
  const modelUse = modelBlock?.use
  if (!modelUse || modelUse.length === 0) return true
  return modelUse.length === 1 && modelUse[0].name === transformer.name
}

/**
 * Resolve the per-model entry on `provider.transformer[modelKey]`. The
 * registry stores arbitrary value kinds at this key (Transformer[],
 * subscription metadata, ...); the type guard isolates the
 * `{ use?: Transformer[] }` shape callers actually want.
 *
 * Exported for the response chain (`response-chain.ts`), which needs the
 * same per-model lookup in reverse order.
 */
export function lookupProviderModelBlock(
  providerTx: ResolvedProviderTransformer | undefined,
  modelKey: string | undefined
): { use?: Transformer[] } | undefined {
  if (!providerTx || modelKey === undefined || modelKey.length === 0) return undefined
  const raw = providerTx[modelKey]
  if (!isProviderModelBlock(raw)) return undefined
  // Narrow the shape: ProviderModelBlock allows `use?: unknown[]`; the
  // registry stores Transformer instances there (resolveUseList builds
  // Transformer[]), so the runtime invariant holds.
  const use = raw.use
  if (use === undefined) return {}
  return { use: filterTransformerInstances(use) }
}

/**
 * Filter an `unknown[]` from the registry shape down to the Transformer
 * instances actually stored there. Defensive — the registry always
 * inserts Transformer instances on the per-model `use` slot — but
 * structural typing requires us to narrow before invoking the methods.
 */
function filterTransformerInstances(values: readonly unknown[]): Transformer[] {
  const out: Transformer[] = []
  for (const v of values) {
    if (isTransformerInstance(v)) out.push(v)
  }
  return out
}

function isTransformerInstance(value: unknown): value is Transformer {
  if (value === null || typeof value !== 'object') return false
  if (!('name' in value) || !('transformRequestIn' in value)) return false
  const name: unknown = Reflect.get(value, 'name')
  const fn: unknown = Reflect.get(value, 'transformRequestIn')
  return typeof name === 'string' && typeof fn === 'function'
}

export async function processRequestTransformers(
  input: PipelineInput,
  bypass: boolean
): Promise<{ requestBody: unknown; config: TransformerConfig }> {
  let requestBody: unknown = input.body
  let config: TransformerConfig = {}

  if (bypass) {
    // Native Anthropic requests with an API key get a fresh upstream header
    // set. Client headers describe the caller, not Rialto's API-key request.
    if (input.provider.authMode === 'api_key' && input.transformer.name === 'anthropic') {
      requestBody = withoutClientBillingMarker(input.body)
      return { requestBody, config: { headers: { 'anthropic-version': '2023-06-01' } } }
    }
    const headers: Record<string, string | undefined> = { ...input.headers }
    for (const key of Object.keys(headers)) {
      if (shouldStripInboundHeader(key)) delete headers[key]
    }
    config = { headers }
    return { requestBody, config }
  }

  // 1. Endpoint transformer's transformRequestOut (wire → unified).
  const transformed = await input.transformer.transformRequestOut(requestBody, input.context)
  requestBody = transformed

  // 2. Provider-level transformer chain.
  const providerTx: ResolvedProviderTransformer | undefined = input.provider.transformer
  const use = Array.isArray(providerTx?.use) ? providerTx.use : []
  for (const step of use) {
    const result = await step.transformRequestIn(asUnifiedRequest(requestBody), input.provider, input.context)
    ;({ requestBody, config } = mergeHookResult(result, requestBody, config))
  }

  // 3. Model-specific chain.
  const view = viewPipelineBody(requestBody)
  const modelBlock = lookupProviderModelBlock(providerTx, view.model)
  const modelUse = modelBlock?.use
  if (modelUse) {
    for (const step of modelUse) {
      const result = await step.transformRequestIn(asUnifiedRequest(requestBody), input.provider, input.context)
      ;({ requestBody, config } = mergeHookResult(result, requestBody, config))
    }
  }

  return { requestBody, config }
}

/**
 * The pipeline carries the in-flight body as `unknown` because every
 * transformer reshapes it differently. transformRequestIn expects a
 * UnifiedChatRequest; this helper is the documented unsafe-narrowing
 * boundary between the loose pipeline state and the strict hook input.
 */
function asUnifiedRequest(body: unknown): UnifiedChatRequest {
  // biome-ignore plugin: pipeline state is unknown by design (every transformer reshapes the body);
  // UnifiedChatRequest is what each hook expects on entry. The cast is the documented boundary.
  return body as UnifiedChatRequest
}

function mergeHookResult(
  result: unknown,
  prevBody: unknown,
  prevConfig: TransformerConfig
): { requestBody: unknown; config: TransformerConfig } {
  if (isTransformerHookResult(result)) {
    const hookConfig: TransformerConfig = result.config !== undefined ? result.config : {}
    return {
      requestBody: result.body,
      config: { ...prevConfig, ...hookConfig }
    }
  }
  // Plain replacement body — fall back to the previous body only when
  // the hook returned no value at all.
  return { requestBody: result === undefined ? prevBody : result, config: prevConfig }
}

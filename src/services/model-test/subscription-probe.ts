/**
 * Subscription-auth probes. Each vendor's upstream request is built by the
 * transformers the proxy runs for that provider rather than written by
 * hand: Claude Code through claude-code-oauth, Codex through
 * openai-responses and then codex-oauth. A hand-written look-alike drifts
 * from the real request without anyone noticing, and a test that judges a
 * request the proxy never sends says nothing about the one it does.
 */

import { isTransformerHookResult, type RuntimeProvider } from '@/schemas/domain/pipeline'
import type { UnifiedChatRequest } from '@/schemas/domain/unified'
import type { OauthSubscriptionAuthBlock } from '@/schemas/wire/oauth'
import { ApiStyle } from '../../generated/prisma/client'
import { ClaudeCodeOauthTransformer } from '../../llms/transformers/anthropic'
import { CodexOauthTransformer, OpenAIResponsesTransformer } from '../../llms/transformers/openai'
import { getUsableSubAccountAuth } from '../subscription-account-sync-service'
import { fetchWithTimeout, formatHttpError, type ProbeResult, reachable } from './http'

const NO_ACCOUNT = 'no usable subscription account on this provider'

// anthropic-beta value the /v1 adapter (api/v1/route.ts) injects on the
// subscription OAuth path. The claude-code-oauth transformer's auth() omits
// it by design (the adapter owns it), so the test adds it to mirror the
// proxy exactly.
const OAUTH_BETA = 'oauth-2025-04-20'

// One usable account as the credential block the transformers read. Null
// when there is no account or it holds no access token — nothing a probe
// could authenticate with.
const credentialBlock = (
  auth: Awaited<ReturnType<typeof getUsableSubAccountAuth>>
): OauthSubscriptionAuthBlock | null =>
  auth === null || !auth.accessToken ? null : { ...auth, accessToken: auth.accessToken }

// The provider as the pipeline sees it at request time, with one account's
// credentials grafted on — resolveSubscriptionAuth reads the bearer back
// out of this overlay. Which account it is does not matter here: the
// question is whether the subscription can serve the model.
const overlayProvider = (
  providerName: string,
  apiBaseUrl: string,
  overlay: OauthSubscriptionAuthBlock
): RuntimeProvider => ({
  name: providerName,
  api_base_url: apiBaseUrl,
  api_key: 'oauth',
  transformer: { use: [], subscriptionAuth: overlay }
})

// Transformers set a header to `undefined` to unset an inbound value, and
// fetch cannot take an undefined header value.
const definedHeaders = (headers: Record<string, string | undefined> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (headers === undefined) return out
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

// Claude Code subscription probe. Build the upstream { headers, body } for a
// ping by running the real claude-code-oauth transformer, then layering the
// adapter's oauth beta header. Returns { error } when there's no usable
// account or the transformer's auth hook throws.
const buildClaudeCodeRequest = async (
  providerName: string,
  apiBaseUrl: string,
  model: string
): Promise<{ headers: Record<string, string>; body: string } | { error: string }> => {
  const overlay = credentialBlock(await getUsableSubAccountAuth(providerName))
  if (overlay === null) return { error: NO_ACCOUNT }
  const runtimeProvider = overlayProvider(providerName, apiBaseUrl, overlay)
  const pingBody = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  let shaped: unknown
  try {
    shaped = await new ClaudeCodeOauthTransformer().auth(pingBody, runtimeProvider, {})
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'subscription auth failed' }
  }
  const hook = isTransformerHookResult(shaped) ? shaped : { body: pingBody, config: undefined }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-beta': OAUTH_BETA,
    ...definedHeaders(hook.config?.headers)
  }
  return { headers, body: JSON.stringify(hook.body) }
}

const probeClaudeCodeSubscription = async (
  providerName: string,
  apiBaseUrl: string,
  model: string
): Promise<ProbeResult> => {
  const built = await buildClaudeCodeRequest(providerName, apiBaseUrl, model)
  if ('error' in built) return { ok: false, error: built.error }
  try {
    const res = await fetchWithTimeout(apiBaseUrl, { method: 'POST', headers: built.headers, body: built.body })
    if (res.ok) return { ok: true }
    const ab = (await res.text()).slice(0, 300)
    if (reachable(res.status, ab)) return { ok: true }
    return { ok: false, error: formatHttpError(res.status, ab) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

/**
 * The upstream request for a Codex subscription ping, built by the chain
 * the proxy runs for this provider: openai-responses, then codex-oauth.
 *
 * The hand-written Responses body this replaced sent `max_output_tokens`,
 * which the ChatGPT backend refuses as an unsupported parameter and
 * codex-oauth strips (#463). That 400 only ever read as a pass because the
 * reachability check matched the field name in its text; once #466 stopped
 * that, every Codex model test failed while the proxy served the same
 * models fine. The chain also brings the backend's required fields, the
 * client headers it classifies traffic by, and a token refreshed through
 * the shared codex-auth lock.
 *
 * Exported for its test — the shape of this request is the regression.
 */
export const buildCodexRequest = async (
  overlay: OauthSubscriptionAuthBlock,
  providerName: string,
  apiBaseUrl: string,
  model: string
): Promise<{ url: string; headers: Record<string, string>; body: string }> => {
  const runtimeProvider = overlayProvider(providerName, apiBaseUrl, overlay)
  // A cap goes in so the probe crosses the same strip a capped proxied
  // request does.
  const ping: UnifiedChatRequest = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
  // openai-responses reshapes the body in place and hands back that same
  // object — bare, or inside a hook result whose only config is a
  // /chat/completions redirect the backend root never triggers — so `ping`
  // is the body the next step reads, as the pipeline passes it on.
  await new OpenAIResponsesTransformer().transformRequestIn(ping, runtimeProvider)
  const shaped = await new CodexOauthTransformer().transformRequestIn(ping, runtimeProvider, {})
  const url = shaped.config?.url
  if (url === undefined) throw new Error('codex-oauth produced no upstream url')
  return {
    url: typeof url === 'string' ? url : url.href,
    headers: definedHeaders(shaped.config?.headers),
    body: JSON.stringify(shaped.body)
  }
}

const probeCodexSubscription = async (
  providerName: string,
  apiBaseUrl: string,
  model: string
): Promise<ProbeResult> => {
  const overlay = credentialBlock(await getUsableSubAccountAuth(providerName))
  if (overlay === null) return { ok: false, error: NO_ACCOUNT }
  try {
    const built = await buildCodexRequest(overlay, providerName, apiBaseUrl, model)
    const res = await fetchWithTimeout(built.url, { method: 'POST', headers: built.headers, body: built.body })
    if (res.ok) {
      // The backend streams; a 200 already proves auth and the model, so
      // release the stream unread.
      await res.body?.cancel().catch(() => {})
      return { ok: true }
    }
    const ab = (await res.text()).slice(0, 300)
    if (reachable(res.status, ab)) return { ok: true }
    return { ok: false, error: formatHttpError(res.status, ab) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

// Subscription probe dispatch, by the provider's wire format.
export const probeSubscription = async (
  style: ApiStyle,
  providerName: string,
  apiBaseUrl: string,
  modelName: string
): Promise<ProbeResult> => {
  if (style === ApiStyle.anthropic) return probeClaudeCodeSubscription(providerName, apiBaseUrl, modelName)
  if (style === ApiStyle.openai_responses) return probeCodexSubscription(providerName, apiBaseUrl, modelName)
  // No other style has a subscription auth step in this build
  // (shared/transformer-chain.ts), so the proxy cannot serve such a
  // provider either; saying so beats probing with a request it never sends.
  return { ok: false, error: `no subscription support for the ${style} api style` }
}

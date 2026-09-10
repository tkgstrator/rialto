/**
 * Subscription-auth probes. Claude Code reuses the real
 * claude-code-oauth transformer to build the upstream request (single
 * source of truth); codex uses the token + chatgpt-account-id via the
 * regular inference probes.
 */

import { isTransformerHookResult, type RuntimeProvider } from '@/schemas/domain/pipeline'
import { ApiStyle } from '../../generated/prisma/client'
import { ClaudeCodeOauthTransformer } from '../../llms/transformers/anthropic'
import { getUsableSubAccountAuth } from '../subscription-account-sync-service'
import { fetchWithTimeout, formatHttpError, type ProbeResult, reachable } from './http'
import { probeInference } from './probes'

// Local, structural type. Never crosses the wire, so no schema/openapi
// envelope is needed.
type SubAuth = { token: string; extraHeaders?: Record<string, string> }

// Read the OAuth access token of one SubAccount that can authenticate
// (decrypted in-memory). The test then makes a *real* authed call
// against the upstream — file-presence checks went away with the move
// to DB-only credential storage. Which account it is does not matter
// here: the question is whether the subscription can serve the model.
const readSubscriptionAuth = async (providerName: string, apiBaseUrl: string): Promise<SubAuth | { error: string }> => {
  const auth = await getUsableSubAccountAuth(providerName)
  if (!auth?.accessToken) return { error: 'no usable subscription account on this provider' }
  if (apiBaseUrl.includes('chatgpt.com') || apiBaseUrl.includes('openai.com')) {
    return {
      token: auth.accessToken,
      extraHeaders: auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}
    }
  }
  // Claude Code sends the OAuth token as x-api-key (handled by the
  // claude-code-oauth transformer at proxy time; the test path uses it
  // as a bearer below).
  return { token: auth.accessToken }
}

// anthropic-beta value the /v1 adapter (api/v1/route.ts) injects on the
// subscription OAuth path. The claude-code-oauth transformer's auth() omits
// it by design (the adapter owns it), so the test adds it to mirror the
// proxy exactly.
const OAUTH_BETA = 'oauth-2025-04-20'

// Claude Code subscription probe. Rather than hand-rolling the OAuth auth
// headers + the Claude Code identity block — which silently drift from the
// real request shape — build the upstream request with the SAME
// claude-code-oauth transformer the proxy runs, then add the adapter's oauth
// beta header. Single source of truth: if the transformer changes, the test
// follows automatically.
// Build the upstream { headers, body } for a Claude Code subscription ping by
// running the real claude-code-oauth transformer, then layering the adapter's
// oauth beta header. Returns { error } when there's no active account or the
// transformer's auth hook throws.
const buildClaudeCodeRequest = async (
  providerName: string,
  apiBaseUrl: string,
  model: string
): Promise<{ headers: Record<string, string>; body: string } | { error: string }> => {
  const overlay = await getUsableSubAccountAuth(providerName)
  if (!overlay?.accessToken) {
    return { error: 'no usable subscription account on this provider' }
  }
  const runtimeProvider: RuntimeProvider = {
    name: providerName,
    api_base_url: apiBaseUrl,
    api_key: 'oauth',
    // resolveSubscriptionAuth reads the bearer back out of this overlay —
    // the same block the pipeline grafts on at request time.
    transformer: { use: [], subscriptionAuth: overlay }
  }
  const pingBody = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  let shaped: unknown
  try {
    shaped = await new ClaudeCodeOauthTransformer().auth(pingBody, runtimeProvider, {})
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'subscription auth failed' }
  }
  const hook = isTransformerHookResult(shaped) ? shaped : { body: pingBody, config: undefined }
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-beta': OAUTH_BETA }
  const shapedHeaders = hook.config?.headers
  if (shapedHeaders) {
    // Skip undefined values: the transformer sets `x-api-key: undefined` to
    // unset the inbound key, but fetch can't take an undefined header value.
    for (const [k, v] of Object.entries(shapedHeaders)) {
      if (typeof v === 'string') headers[k] = v
    }
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

// Subscription probe dispatch. Anthropic (Claude Code) reuses the real
// transformer; codex (Responses API to the ChatGPT backend) uses the token +
// chatgpt-account-id responses probe.
export const probeSubscription = async (
  style: ApiStyle,
  providerName: string,
  apiBaseUrl: string,
  modelName: string
): Promise<ProbeResult> => {
  if (style === ApiStyle.anthropic) {
    return probeClaudeCodeSubscription(providerName, apiBaseUrl, modelName)
  }
  const auth = await readSubscriptionAuth(providerName, apiBaseUrl)
  if ('error' in auth) return { ok: false, error: auth.error }
  return probeInference(style, apiBaseUrl, auth.token, modelName, auth.extraHeaders)
}

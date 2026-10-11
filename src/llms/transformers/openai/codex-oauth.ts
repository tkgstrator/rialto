/**
 * Codex (ChatGPT subscription) OAuth transformer.
 *
 * Unlike claude-code (Anthropic in, Anthropic out — a passthrough that
 * only needs an auth header), codex talks the OpenAI Responses API to
 * the ChatGPT backend. So it runs the full transform chain (anthropic
 * endpoint transformer -> openai-responses) and this transformer sits
 * LAST in the provider's `use` list: openai-responses has already
 * reshaped the body to Responses format, and this step makes it the
 * request Codex CLI itself would send — the body (`./codex/request-shape`)
 * and the markers the CLI identifies itself with (`./codex/client-identity`)
 * — plus the subscription auth.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import { ensureFreshCodexAccessToken } from '../../../services/codex-auth/token'
import { sessionIdFromRequest } from '../../pipeline/session-id'
import { codexAccountTag } from '../../utils/codex-reasoning'
import { isObject } from '../../utils/guards'
import { cloneResponse } from '../../utils/response-clone'
import { OAuthTransformer, type SubscriptionTokenState } from '../oauth-base'
import { CODEX_ORIGINATOR, CODEX_USER_AGENT, codexTurnIdentity } from './codex/client-identity'
import { codexCallerIntent, shapeCodexBody } from './codex/request-shape'

export { CODEX_ORIGINATOR, CODEX_USER_AGENT }

// OpenAI routes its prompt cache by `prompt_cache_key`; the official CLI
// uses a per-session uuid. This proxy derives a deterministic key from the
// stable request prefix instead — model, instructions, the developer
// instructions that open the input, and tools — so every turn of the same
// conversation hashes identically and hits the cache, and conversations
// that share a prefix share it too.
function promptCacheKey(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input : []
  const opening = input.filter((item) => isObject(item) && item.role === 'developer')
  const model = typeof body.model === 'string' ? body.model : ''
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  return createHash('sha256')
    .update(`${model}\n${instructions}\n${JSON.stringify(opening)}\n${JSON.stringify(body.tools ? body.tools : [])}`)
    .digest('hex')
    .slice(0, 32)
}

export class CodexOauthTransformer extends OAuthTransformer {
  readonly name = 'codex-oauth'

  // The OAuth grant requested `offline_access`, so the token endpoint
  // issues a rotating refresh_token alongside the access_token. Delegate
  // to the shared codex-auth path rather than the base class's default:
  // it decides freshness from the access token's own `exp` claim (the
  // stored `expiresAt` used to hold the SUBSCRIPTION end date for Codex,
  // which suppressed every refresh), and it shares one in-flight lock
  // with the profile-sync job and the usage poller so the rotating
  // refresh_token is never spent twice.
  protected async ensureFreshToken(auth: SubscriptionTokenState): Promise<string> {
    return ensureFreshCodexAccessToken({
      subAccountId: auth.subAccountId,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt
    })
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    context: TransformerContext
  ): Promise<TransformerHookResult> {
    // See claude-code-oauth: resolved once per request by the route
    // layer, absent only on probe contexts, which stay on the overlay.
    const sessionId = context?.req?.accountSessionKey
    const { token, accountId } = await this.resolveSubscriptionAuth(provider, sessionId, 'codex', request, context)
    // Stamped by resolveSubscriptionAuth: the account this attempt runs on.
    const subAccountId = context?.req?.subAccountId

    const inFlight: Record<string, unknown> = { ...request }
    const shaped = shapeCodexBody(
      inFlight,
      codexCallerIntent(context?.req),
      subAccountId === undefined ? null : codexAccountTag(subAccountId)
    )

    // provider.api_base_url is the codex backend root
    // (https://chatgpt.com/backend-api/codex); the Responses endpoint
    // is one level down. sendRequestToProvider uses config.url verbatim
    // when set, otherwise provider.api_base_url.
    const base = (provider.api_base_url ? provider.api_base_url : '').replace(/\/+$/, '')
    const url = /\/responses$/.test(base) ? base : `${base}/responses`

    // Reuse the inbound session ID so ChatGPT sees a stable thread for the
    // lifetime of the client's session (aids server-side caching). Fall
    // back to a fresh UUID only when the client didn't send one — read
    // from the request rather than from `sessionId` above, whose fallback
    // is a Rialto-internal client identity ("token:<id>") that has no
    // business being announced upstream as a thread id.
    const carriedSessionId = sessionIdFromRequest(context?.req?.headers, context?.req?.body)
    const threadId = carriedSessionId !== undefined ? carriedSessionId : randomUUID()
    const reasoning = shaped.reasoning
    const identity = codexTurnIdentity({
      threadId,
      subAccountId,
      model: typeof shaped.model === 'string' ? shaped.model : undefined,
      effort: isObject(reasoning) && typeof reasoning.effort === 'string' ? reasoning.effort : undefined
    })

    return {
      body: { ...shaped, prompt_cache_key: promptCacheKey(shaped), client_metadata: identity.clientMetadata },
      config: {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          originator: CODEX_ORIGINATOR,
          'user-agent': CODEX_USER_AGENT,
          ...identity.headers,
          ...(accountId ? { 'chatgpt-account-id': accountId } : {})
        }
      }
    }
  }

  // Response chain runs reversed, so this fires BEFORE openai-responses.
  // The ChatGPT codex backend streams a Responses-API SSE body but does
  // NOT send `Content-Type: text/event-stream`. openai-responses (and
  // then the anthropic endpoint transformer) branch on Content-Type and
  // otherwise JSON.parse the body — which throws on "event: response…".
  // Re-tag a successful stream so the SSE branch is taken. Non-2xx
  // bodies are genuine JSON errors; leave them untouched.
  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    if (!response.ok) return response
    const ct = response.headers.get('content-type')
    if (ct?.includes('text/event-stream')) return response
    return cloneResponse(response, response.body, { 'content-type': 'text/event-stream' })
  }
}

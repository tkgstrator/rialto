/**
 * Codex (ChatGPT subscription) OAuth transformer.
 *
 * Unlike claude-code (Anthropic in, Anthropic out — a passthrough that
 * only needs an auth header), codex talks the OpenAI Responses API to
 * the ChatGPT backend. So it runs the full transform chain (anthropic
 * endpoint transformer -> openai-responses) and this transformer sits
 * LAST in the provider's `use` list: openai-responses has already
 * reshaped the body to Responses format, and we add the subscription
 * auth + the chatgpt.com/backend-api/codex requirements.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch } from 'node:os'
import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import { type CodexRequestShape, PackageJsonSchema } from '@/schemas/wire'
import { ensureFreshCodexAccessToken } from '../../../services/codex-auth/token'
import { cloneResponse } from '../../utils/response-clone'
import { OAuthTransformer, type SubscriptionTokenState } from '../oauth-base'

// Identify as the official Codex CLI. The ChatGPT backend classifies a
// request as "CLI" (subscription allotment) vs "Other" (overage) by
// these markers; without them codex requests bill as Other and skip the
// CLI path. Version source order: CODEX_CLI_VERSION env (lets prod pin
// it if @openai/codex is ever pruned) -> the installed @openai/codex
// package -> "0.0.0". Resolved once at boot; never throws.
const CODEX_USER_AGENT: string = (() => {
  const safe = (fn: () => string, fallback: string): string => {
    try {
      const v = fn().trim()
      return v.length > 0 ? v : fallback
    } catch {
      return fallback
    }
  }
  const envVer = (process.env.CODEX_CLI_VERSION ? process.env.CODEX_CLI_VERSION : '').trim()
  const codexVer =
    envVer.length > 0
      ? envVer
      : safe(() => {
          const pkg = PackageJsonSchema.safeParse(createRequire(import.meta.url)('@openai/codex/package.json'))
          if (!pkg.success) throw new Error('@openai/codex/package.json: missing version field')
          return pkg.data.version
        }, '0.0.0')
  const osStr = safe(() => {
    const rel = readFileSync('/etc/os-release', 'utf-8')
    const nameMatch = rel.match(/^NAME="?([^"\n]+)"?/m)
    const verMatch = rel.match(/^VERSION_ID="?([^"\n]+)"?/m)
    const name = nameMatch ? nameMatch[1] : 'Linux'
    const ver = verMatch ? verMatch[1] : ''
    return `${name} ${ver}`.trim()
  }, 'Linux')
  return `codex_cli/${codexVer} (${osStr}; ${arch()})`
})()

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
    const sessionId = (context?.req?.headers?.['x-claude-code-session-id'] as string | undefined) ?? undefined
    const { token, accountId } = await this.resolveSubscriptionAuth(provider, sessionId, 'codex')
    // biome-ignore plugin: CodexRequestShape adds optional Responses-API-specific fields (store/instructions/input/prompt_cache_key) on top of UnifiedChatRequest; the unified schema cannot model these without leaking codex-specific shape into the shared type.
    const req = request as CodexRequestShape

    // chatgpt.com/backend-api/codex requires `instructions`, `input` as
    // a list, store=false and stream=true. openai-responses already
    // produced `input` and lifts `instructions` from the system block;
    // enforce the rest (and a non-empty instructions fallback).
    req.store = false
    req.stream = true
    if (typeof req.instructions !== 'string' || req.instructions.length === 0) {
      req.instructions = 'You are a helpful assistant.'
    }

    // The output ceiling stops here. openai-responses translates the
    // unified cap into `max_output_tokens` because the public Responses
    // API takes it, but this backend allow-lists top-level params and
    // was reported answering 400 "Unsupported parameter" for it (#463).
    // Losing the ceiling costs a cap; sending it costs the request.
    // biome-ignore plugin: explicit removal of a field the backend rejects — CodexRequestShape does not model max_output_tokens and the schema cannot express deletion.
    delete (req as { max_output_tokens?: unknown }).max_output_tokens

    // OpenAI routes its prompt cache by `prompt_cache_key`; the official
    // CLI uses a per-session uuid. This proxy is stateless, so derive a
    // deterministic key from the stable request prefix instead — every
    // turn of the same conversation hashes identically and hits the
    // cache, fixing the prefix being re-billed each turn.
    const cacheModel = req.model ? req.model : ''
    const cacheInstructions = req.instructions ? req.instructions : ''
    const cacheTools = JSON.stringify(req.tools ? req.tools : [])
    req.prompt_cache_key = createHash('sha256')
      .update(`${cacheModel}\n${cacheInstructions}\n${cacheTools}`)
      .digest('hex')
      .slice(0, 32)

    // provider.api_base_url is the codex backend root
    // (https://chatgpt.com/backend-api/codex); the Responses endpoint
    // is one level down. sendRequestToProvider uses config.url verbatim
    // when set, otherwise provider.api_base_url.
    const base = (provider.api_base_url ? provider.api_base_url : '').replace(/\/+$/, '')
    const url = /\/responses$/.test(base) ? base : `${base}/responses`

    // Reuse the inbound session ID so ChatGPT sees a stable session for
    // the lifetime of the Claude Code session (aids server-side caching).
    // Fall back to a fresh UUID only when the client didn't send one.
    const upstreamSessionId = sessionId ?? randomUUID()
    const threadId = upstreamSessionId
    const windowId = `${upstreamSessionId}:0`

    return {
      body: req,
      config: {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          originator: 'codex_cli',
          'user-agent': CODEX_USER_AGENT,
          session_id: upstreamSessionId,
          thread_id: threadId,
          'x-client-request-id': randomUUID(),
          'x-codex-beta-features': 'terminal_resize_reflow',
          'x-codex-window-id': windowId,
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

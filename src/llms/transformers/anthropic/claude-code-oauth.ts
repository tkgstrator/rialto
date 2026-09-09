/**
 * Claude Code subscription OAuth transformer.
 *
 * Identifies the request as the official Claude Code client by attaching:
 *   1. an OAuth bearer (not x-api-key)
 *   2. the Claude Code identity string as the first system block
 *
 * The anthropic-beta `oauth-2025-04-20` header is added by the /v1
 * adapter on the subscription path so other client betas are preserved
 * verbatim.
 */

import { HTTPException } from 'hono/http-exception'
import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import { OauthRefreshResponseSchema } from '@/schemas/wire/oauth'
import { cloneResponse } from '../../utils/response-clone'
import type { TransformerAuthResult } from '../base'
import { type OAuthRefreshResult, OAuthTransformer } from '../oauth-base'
import { convertAnthropicResponseToChat, isAnthropicMessageResponse } from './response-to-chat'

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// A Claude subscription OAuth token only gets the subscription's model
// allotment (incl. premium models like Opus/Sonnet) when the request is
// identified as official Claude Code. Without this, premium models are
// routed to the API "overage" path instead — which is org-disabled on
// subscriptions — and 429 with rate_limit_error while Haiku (served from
// the base allotment) still 200s.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

type AnthropicSystemBlock = {
  type?: string
  text?: string
  cache_control?: unknown
}

// Anthropic system is a string or an array of text blocks. Normalise to
// an array and guarantee the first block is the Claude Code identity,
// without duplicating it if the caller already sent it. Blocks are kept
// verbatim (only bare strings are wrapped) so any cache_control Claude
// Code attached survives — Anthropic prompt caching is prefix-based, and
// rebuilding blocks as plain {type,text} dropped the cache breakpoints,
// re-billing the whole system/tools prefix as fresh input every turn.
function toSystemBlock(value: unknown): AnthropicSystemBlock {
  if (typeof value === 'string') return { type: 'text', text: value }
  if (value === null || typeof value !== 'object') return {}
  const type = Reflect.get(value, 'type')
  const text = Reflect.get(value, 'text')
  const cache_control = Reflect.get(value, 'cache_control')
  return {
    type: typeof type === 'string' ? type : undefined,
    text: typeof text === 'string' ? text : undefined,
    cache_control
  }
}

export function withClaudeCodeIdentity(system: unknown): AnthropicSystemBlock[] {
  let blocks: AnthropicSystemBlock[]
  if (typeof system === 'string') {
    blocks = system.length > 0 ? [{ type: 'text', text: system }] : []
  } else if (Array.isArray(system)) {
    blocks = system.map(toSystemBlock)
  } else {
    blocks = []
  }
  // Claude Code (≥2.1.146) places a billing-header block at [0] and the
  // identity at [1], so checking only blocks[0] missed the identity and
  // prepended a duplicate — breaking the prompt-cache prefix every turn.
  const hasIdentity = blocks.some((b) => typeof b.text === 'string' && b.text.startsWith(CLAUDE_CODE_IDENTITY))
  if (hasIdentity) return blocks
  return [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...blocks]
}

type ClaudeCodeRequestShape = {
  system?: unknown
  messages?: Array<{ content?: unknown; [k: string]: unknown }>
  thinking?: unknown
  [k: string]: unknown
}

// Prefixes Rialto stamps on thinking signatures it synthesises itself
// when an upstream produced reasoning without one (see the Gemini
// streaming converter). Those are placeholders that let a client pair
// text with reasoning locally — they are NOT Anthropic signatures and
// Anthropic cannot validate them.
//
// Only the current prefix is matched. A synthesised signature is written
// into the client's transcript and replayed on every later turn, so any
// `ccr_` placeholder minted before the rename is now forwarded to
// Anthropic, which rejects it and 400s that conversation for good.
// Dropped deliberately, having confirmed no such placeholder exists in
// this install's transcripts; restarting an affected conversation is the
// only remedy if one ever turns up.
const SYNTHETIC_SIGNATURE_PREFIXES = ['rialto_']

export function keepSignedBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return true
  const type = Reflect.get(block, 'type')
  if (type !== 'thinking') return true
  const signature = Reflect.get(block, 'signature')
  if (typeof signature !== 'string' || signature.length === 0) return false
  // A Rialto-minted placeholder is as unusable to Anthropic as no
  // signature at all. Checking only for non-empty let these through, so a
  // turn that had been routed to a non-Anthropic provider poisoned every
  // later Anthropic turn in the same conversation with a signature the
  // upstream rejects — and the transcript replays it on every request, so
  // the failure is permanent for that conversation rather than transient.
  return !SYNTHETIC_SIGNATURE_PREFIXES.some((prefix) => signature.startsWith(prefix))
}

export class ClaudeCodeOauthTransformer extends OAuthTransformer {
  readonly name = 'claude-code-oauth'
  readonly endPoint = '/v1/messages'

  protected async refresh(input: { refreshToken: string }): Promise<OAuthRefreshResult | null> {
    const response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: CLIENT_ID
      })
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // biome-ignore plugin: Hono's HTTPException status is a closed union of supported HTTP codes; arbitrary upstream codes must be widened.
      throw new HTTPException(response.status as never, {
        message: `Token refresh failed: ${response.status} ${detail}`.trim()
      })
    }
    const result = OauthRefreshResponseSchema.safeParse(await response.json())
    if (!result.success) {
      throw new HTTPException(502, { message: `Invalid OAuth refresh response: ${result.error.message}` })
    }
    const expiresInSec = result.data.expires_in !== undefined ? result.data.expires_in : 3600
    return {
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresAt: new Date(Date.now() + expiresInSec * 1000)
    }
  }

  async auth(request: unknown, provider: RuntimeProvider, context: TransformerContext): Promise<TransformerAuthResult> {
    const sessionId = (context?.req?.headers?.['x-claude-code-session-id'] as string | undefined) ?? undefined
    const { token } = await this.resolveSubscriptionAuth(provider, sessionId, 'claude', request)
    // biome-ignore plugin: the OAuth auth hook receives the inbound Anthropic body verbatim (unknown by design); narrowing to a Zod schema would re-encode the whole request, defeating the bypass-mode passthrough.
    const req = request as ClaudeCodeRequestShape
    req.system = withClaudeCodeIdentity(req.system)

    // Remove thinking blocks that lack a valid Anthropic signature. When
    // conversation turns are routed to different providers, thinking
    // blocks generated by another provider carry either no signature or
    // a Rialto-minted placeholder, neither of which Anthropic can validate,
    // causing a 400 "Invalid `signature` in `thinking` block". Both cases
    // are dropped by keepSignedBlock. Blocks that originated from
    // Anthropic carry a real signature and must be preserved — stripping
    // them invalidates the prompt-cache prefix and re-bills the full
    // context. redacted_thinking blocks are Anthropic-native and are
    // always kept.
    if (Array.isArray(req.messages)) {
      req.messages = req.messages.map((msg) => {
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((block) => keepSignedBlock(block))
        return { ...msg, content: filtered }
      })
    }

    // `thinking` is forwarded verbatim. Anthropic accepts `enabled`
    // and `disabled` today (verified empirically against
    // api.anthropic.com/v1/messages with claude-sonnet-4-5); shapes it
    // does not accept (`adaptive`, unknown values) 400 back to the
    // client, which is the correct feedback signal. Rialto previously
    // stripped `disabled` here as a compat shim for an older Anthropic
    // that 400'd it — the shim silently converted the caller's
    // opt-OUT into a server-side adaptive default, so the model burned
    // thinking tokens on requests the user explicitly opted out of.

    return {
      body: req,
      config: {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'x-api-key': undefined
        }
      }
    }
  }

  // Passthrough — request is already in Anthropic format
  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<never> {
    // biome-ignore plugin: bypass-mode passthrough — the request is already in the upstream wire shape; the abstract base's signature returns UnifiedChatRequest but here we return whatever came in.
    return request as never
  }

  // Non-bypass provider-chain hook. Fires when the endpoint transformer
  // is NOT claude-code-oauth (i.e. the caller hit /v1/chat/completions
  // or /v1/responses instead of /v1/messages). Without this override,
  // only `auth()` runs — and only in bypass mode — leaving the outgoing
  // request with no OAuth bearer. `applySubscriptionAuth` stamps
  // `api_key: 'oauth'` on the provider as a marker, and `sendToProvider`
  // then forwards that literal string as the Bearer, so Anthropic
  // upstream sees `Authorization: Bearer oauth` and 401s with
  // "Invalid bearer token". Reuses the same auth() logic so the
  // Claude Code identity injection + thinking-strip stay consistent.
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    context: TransformerContext
  ): Promise<TransformerHookResult> {
    const auth = await this.auth(request, provider, context)
    return { body: auth.body, config: auth.config }
  }

  async transformResponseIn(response: Response, _context?: TransformerContext): Promise<Response> {
    return response
  }

  // Non-bypass provider-chain outbound hook (mirror of transformRequestIn).
  // Fires when the endpoint transformer is NOT claude-code-oauth — i.e.
  // the caller hit /v1/chat/completions or /v1/responses instead of
  // /v1/messages. Anthropic upstream returns its native message envelope
  // (`{type:'message', content:[{type:'text',text}], usage:{input_tokens,
  // output_tokens}}`), but the OpenAI-compat caller expects
  // `{object:'chat.completion', choices:[{message,finish_reason}], usage:{
  // prompt_tokens, completion_tokens, total_tokens}}`. Detect the Anthropic
  // shape and convert; leave everything else untouched (bypass mode never
  // reaches this hook, so /v1/messages callers still see the raw Anthropic
  // response). SSE streams are passed through unchanged for now — an
  // incremental Anthropic-SSE → Chat-SSE converter is a follow-up.
  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    if (!response.ok) return response
    const contentType = response.headers.get('content-type')
    // SSE not yet supported for cross-shape (Anthropic → Chat) streams.
    // Passthrough keeps the client's stream reader happy syntactically
    // even though the event shapes will confuse an OpenAI SDK parser.
    if (typeof contentType === 'string' && contentType.includes('text/event-stream')) return response
    const raw = await response.text()
    if (raw.length === 0) return response
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Non-JSON body (upstream 4xx text, HTML from a fronting proxy) —
      // hand it back untouched. Rewrapping non-JSON would hide the real
      // error from the client.
      return cloneResponse(response, raw)
    }
    if (!isAnthropicMessageResponse(parsed)) {
      // Already Chat-shape / Responses-shape / unknown. Return as-is
      // rather than crashing — the endpoint transformer downstream will
      // either accept it or the client will surface the mismatch.
      return cloneResponse(response, raw)
    }
    const chat = convertAnthropicResponseToChat(parsed)
    return cloneResponse(response, JSON.stringify(chat))
  }
}

/**
 * Claude Code subscription OAuth transformer.
 *
 * Identifies the request as the official Claude Code client by attaching:
 *   1. an OAuth bearer (not x-api-key)
 *   2. the Claude Code identity string as the first system block
 *
 * Two paths reach it. On the bypass path (`/v1/messages`, the body already
 * Anthropic's) only `auth()` runs, and the anthropic-beta
 * `oauth-2025-04-20` header is added by the /v1 adapter so the client's
 * other betas are preserved verbatim. On the conversion path (an OpenAI or
 * Gemini caller routed to Claude) `transformRequestIn` converts the unified
 * body to Anthropic Messages (`request-from-unified.ts`) and writes every
 * header itself — none of the client's are forwarded there — and
 * `transformResponseOut` converts the reply back to Chat.
 */

import { HTTPException } from 'hono/http-exception'
import type { RuntimeProvider, TransformerContext, TransformerHookResult, UnifiedChatRequest } from '@/schemas/domain'
import { OauthRefreshResponseSchema } from '@/schemas/wire/oauth'
import type { TransformerAuthResult } from '../base'
import { type OAuthRefreshResult, OAuthTransformer } from '../oauth-base'
import { convertUnifiedToAnthropic } from './request-from-unified'
import { convertAnthropicReplyToChat } from './response-to-chat-stream'

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

// Anthropic authenticates an OAuth bearer only alongside this beta. The
// bypass path gets it from the /v1 adapter (`prepareSubscriptionBetas`),
// which edits the client's headers; the conversion path forwards none of
// those, so this transformer has to send it.
const OAUTH_BETA = 'oauth-2025-04-20'
const ANTHROPIC_VERSION = '2023-06-01'

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

// Anthropic takes the system prompt as a top-level `system`, never as
// `messages[0]`; forwarded there, it answers 400 "messages.0: use the
// top-level 'system' parameter for the initial system prompt". This hook
// was written for OpenAI-surface callers, whose system prompt is a leading
// `role: 'system'` message; those now reach Anthropic through
// `convertUnifiedToAnthropic`, which hoists the same way. It stays on the
// bypass body `auth()` shapes, unchanged.
//
// Every system message is taken, not just the first: a client is free to
// send several (one per stable prefix block) and dropping the later ones
// would silently lose instructions. Order is preserved, and an existing
// top-level `system` stays in front of them.
function hoistSystemMessages(req: ClaudeCodeRequestShape): void {
  if (!Array.isArray(req.messages)) return
  const carried = req.messages.filter((message) => message.role === 'system')
  if (carried.length === 0) return

  req.messages = req.messages.filter((message) => message.role !== 'system')

  const existing = Array.isArray(req.system)
    ? req.system
    : typeof req.system === 'string' && req.system.length > 0
      ? [req.system]
      : []
  req.system = [...existing, ...carried.map((message) => systemText(message.content))].filter(
    (block) => typeof block !== 'string' || block.length > 0
  )
}

// Unified message content is a string, or an array of blocks of which only
// the text ones carry the prompt. Anything else (images, tool results) has
// no place in a system block and is dropped rather than stringified.
function systemText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block === null || typeof block !== 'object') return ''
      const text = Reflect.get(block, 'text')
      return typeof text === 'string' ? text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n\n')
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
    // The route layer resolves this once per request and it is never
    // absent on proxied traffic; a context without one is a probe (model
    // test), which wants the provider's own active account and so stays
    // on the overlay path inside resolveSubscriptionAuth.
    const sessionId = context?.req?.accountSessionKey
    const { token } = await this.resolveSubscriptionAuth(provider, sessionId, 'claude', request, context)
    // biome-ignore plugin: the OAuth auth hook receives the inbound Anthropic body verbatim (unknown by design); narrowing to a Zod schema would re-encode the whole request, defeating the bypass-mode passthrough.
    const req = request as ClaudeCodeRequestShape
    hoistSystemMessages(req)
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

    // `thinking` is not touched here. A caller's `disabled` is fitted to
    // the target model later, in pipeline/thinking-off.ts, once the
    // effort that will be sent is settled: which way of switching
    // thinking off a model takes (if any) depends on both, and is probed
    // per model rather than assumed. Stripping `disabled` outright, as an
    // earlier shim did, turned the caller's opt-out into a server-side
    // adaptive default on models that honour it.

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

  // Conversion-path hook: the endpoint transformer is not this one, so the
  // caller hit /v1/chat/completions, /v1/responses or the Gemini surface,
  // and the body is unified (Chat-shaped). It is converted to Anthropic
  // Messages, then given what `auth()` gives a bypass body: the Claude Code
  // identity, and the subscription's bearer. Without the bearer the
  // provider's `api_key: 'oauth'` marker went out as the token and
  // Anthropic answered 401 "Invalid bearer token". The conversion emits no
  // thinking blocks, so there is nothing for `keepSignedBlock` to filter.
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    context: TransformerContext
  ): Promise<TransformerHookResult> {
    const sessionId = context?.req?.accountSessionKey
    const { token } = await this.resolveSubscriptionAuth(provider, sessionId, 'claude', request, context)
    const body = convertUnifiedToAnthropic(request, provider, context)
    body.system = withClaudeCodeIdentity(body.system)
    return {
      body,
      config: {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': OAUTH_BETA,
          'x-api-key': undefined
        }
      }
    }
  }

  async transformResponseIn(response: Response, _context?: TransformerContext): Promise<Response> {
    return response
  }

  // The conversion path's reply hook (mirror of transformRequestIn): the
  // Anthropic answer, streamed or not, in Chat shape for the surface's own
  // endpoint converter. Bypass never reaches it, so /v1/messages callers
  // still see the raw Anthropic response.
  async transformResponseOut(response: Response, _context: TransformerContext): Promise<Response> {
    return convertAnthropicReplyToChat(response, this.logger)
  }
}

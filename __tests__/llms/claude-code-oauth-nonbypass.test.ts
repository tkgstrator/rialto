/**
 * Regression: `/v1/chat/completions` and `/v1/responses` targeting a
 * `claude-code,*` model returned 401 from Anthropic with
 * "Invalid bearer token" — because `claude-code-oauth`'s auth was only
 * wired into the bypass path. Non-bypass ran the provider chain, and
 * the transformer had no `transformRequestIn` override, so no OAuth
 * bearer was ever attached. `applySubscriptionAuth` stamps
 * `api_key: 'oauth'` as a marker; sendToProvider then forwards that
 * literal string as the Bearer, which Anthropic rejects.
 *
 * These tests exercise the new transformRequestIn directly and assert
 * (a) the OAuth bearer lands in the outgoing config.headers,
 * (b) the auth() body mutations still fire (Claude Code identity in
 * system[0], thinking-strip).
 */

import { describe, expect, test } from 'bun:test'
import { ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../src/schemas/domain'

// A minimal RuntimeProvider carrying an already-active subscription
// account overlay — the same shape applySubscriptionAuth writes onto
// the provider so resolveSubscriptionAuth's fallback branch can pick
// it up without a DB round-trip.
function providerWithSubscriptionAuth(accessToken: string, subAccountId: string): RuntimeProvider {
  // biome-ignore plugin: constructing a minimal RuntimeProvider stub — the transformer only reads api_base_url + transformer.subscriptionAuth.
  return {
    name: 'claude-code',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    api_key: 'oauth',
    transformer: {
      subscriptionAuth: {
        subAccountId,
        accessToken,
        // A far-future expiry avoids the base class's refresh-if-near-expiry
        // path; we're testing auth injection, not the refresh dance.
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        accountId: undefined,
        refreshToken: null
      }
    }
  } as unknown as RuntimeProvider
}

const ctx = { req: { headers: {} } } as unknown as TransformerContext

describe('ClaudeCodeOauthTransformer.transformRequestIn — non-bypass provider-chain path', () => {
  const t = new ClaudeCodeOauthTransformer()

  test('attaches OAuth bearer + drops x-api-key so Anthropic upstream sees the real token', async () => {
    const provider = providerWithSubscriptionAuth('claude-oauth-token-abc', 'sub_1')
    const request: UnifiedChatRequest = {
      // biome-ignore plugin: minimal UnifiedChatRequest stub — the base type requires tools/stream and we intentionally omit them to prove defaults hold.
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }]
    } as unknown as UnifiedChatRequest
    const hook = await t.transformRequestIn(request, provider, ctx)
    expect(hook.config?.headers?.Authorization).toBe('Bearer claude-oauth-token-abc')
    // The Anthropic API rejects requests carrying BOTH x-api-key and
    // OAuth Authorization; the auth hook explicitly unsets x-api-key
    // by writing `undefined` (Hono / TransformerConfig treats undefined
    // as "remove this header").
    expect(hook.config?.headers?.['x-api-key']).toBeUndefined()
  })

  test('body still gets the Claude Code identity prepended to system[0]', async () => {
    const provider = providerWithSubscriptionAuth('t', 'sub_1')
    const request: UnifiedChatRequest = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }]
    } as unknown as UnifiedChatRequest
    const hook = await t.transformRequestIn(request, provider, ctx)
    // biome-ignore plugin: transformRequestIn's returned body is unknown by shape (bypass-mode mutates in place with claude-code-specific fields). Narrow structurally.
    const body = hook.body as { system?: Array<{ type?: string; text?: string }> }
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system?.[0]?.type).toBe('text')
    expect(body.system?.[0]?.text).toContain("Claude Code, Anthropic's official CLI")
  })

  /*
    Regression: a caller on /v1/responses or /v1/chat/completions has no
    top-level `system` to send — the OpenAI wire shape carries the system
    prompt as messages[0]. Forwarded as-is, Anthropic answered 400
    "messages.0: use the top-level 'system' parameter for the initial
    system prompt", so nothing streamed for any caller with a system prompt.
  */
  test('a leading system message is hoisted to the top-level system', async () => {
    const provider = providerWithSubscriptionAuth('t', 'sub_1')
    const request = {
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' }
      ]
    } as unknown as UnifiedChatRequest
    const hook = await t.transformRequestIn(request, provider, ctx)
    // biome-ignore plugin: same structural narrowing note as above.
    const body = hook.body as {
      system?: Array<{ text?: string }>
      messages?: Array<{ role?: string }>
    }
    expect(body.messages?.map((message) => message.role)).toEqual(['user'])
    expect(body.system?.map((block) => block.text)).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'You are terse.'
    ])
  })

  test('several system messages are all carried over, in order', async () => {
    const provider = providerWithSubscriptionAuth('t', 'sub_1')
    const request = {
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'system', content: [{ type: 'text', text: 'Sheet.' }] },
        { role: 'user', content: 'hi' }
      ]
    } as unknown as UnifiedChatRequest
    const hook = await t.transformRequestIn(request, provider, ctx)
    // biome-ignore plugin: same structural narrowing note as above.
    const body = hook.body as { system?: Array<{ text?: string }> }
    expect(body.system?.map((block) => block.text)).toEqual([
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'Rules.',
      'Sheet.'
    ])
  })

  test('unsigned thinking blocks are stripped from message content', async () => {
    const provider = providerWithSubscriptionAuth('t', 'sub_1')
    const request = {
      model: 'claude-haiku-4-5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'no signature' },
            { type: 'text', text: 'kept' }
          ]
        }
      ]
    } as unknown as UnifiedChatRequest
    const hook = await t.transformRequestIn(request, provider, ctx)
    // biome-ignore plugin: same structural narrowing note as above.
    const body = hook.body as { messages: Array<{ content: Array<{ type: string }> }> }
    const kinds = body.messages[0].content.map((b) => b.type)
    expect(kinds).toEqual(['text'])
  })
})

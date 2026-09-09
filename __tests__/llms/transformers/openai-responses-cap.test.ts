/**
 * The output ceiling across the OpenAI surfaces.
 *
 * Every surface spells the cap differently — unified and chat use
 * `max_tokens`, gpt-5.x chat wants `max_completion_tokens`, and the
 * Responses API wants `max_output_tokens` — so the field is renamed at
 * each hop rather than passed through. These tests pin the Responses hop
 * and the one upstream that must not receive it.
 *
 * Measured against api.openai.com/v1/responses while writing this:
 * `max_output_tokens` is accepted and honoured at any value >= 16, and
 * rejected below that with 400 "integer_below_min_value". A cap small
 * enough that hidden reasoning consumes it comes back 200 with
 * `status: "incomplete"` and no message item — the vendor's own
 * behaviour, which a gateway should reproduce rather than mask.
 */

import { describe, expect, test } from 'bun:test'
import type { OauthCredentials } from '../../../src/llms/transformers/oauth-base'
import { CodexOauthTransformer } from '../../../src/llms/transformers/openai/codex-oauth'
import { OpenAIResponsesTransformer } from '../../../src/llms/transformers/openai/endpoint-responses'
import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '../../../src/schemas/domain'

// An api_key provider whose upstream is the real Responses API — the
// case the codex-only assumption used to miss.
const responsesProvider: RuntimeProvider = {
  name: 'openai',
  api_base_url: 'https://api.openai.com/v1/responses',
  api_key: 'sk-test'
}

const unified = (extra: Record<string, unknown>): UnifiedChatRequest => {
  // biome-ignore plugin: minimal UnifiedChatRequest stub — the transformer only reads model/messages plus the cap fields under test.
  return {
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'ping' }],
    ...extra
  } as unknown as UnifiedChatRequest
}

// transformRequestIn returns either the mutated request or a hook
// wrapping it; both carry the same object.
const bodyOf = (result: unknown): Record<string, unknown> => {
  const r = Object(result)
  return 'body' in r ? Object(r.body) : r
}

describe('OpenAIResponsesTransformer.transformRequestIn — output ceiling', () => {
  const t = new OpenAIResponsesTransformer()

  test('renames the unified max_tokens to max_output_tokens', async () => {
    const out = bodyOf(await t.transformRequestIn(unified({ max_tokens: 256 }), responsesProvider))
    expect(out.max_output_tokens).toBe(256)
    expect('max_tokens' in out).toBe(false)
  })

  test('picks up a max_completion_tokens an earlier chain step renamed', async () => {
    const out = bodyOf(await t.transformRequestIn(unified({ max_completion_tokens: 512 }), responsesProvider))
    expect(out.max_output_tokens).toBe(512)
    expect('max_completion_tokens' in out).toBe(false)
  })

  test('the gpt-5.x rename wins when both spellings are present', async () => {
    const req = unified({ max_tokens: 256, max_completion_tokens: 512 })
    const out = bodyOf(await t.transformRequestIn(req, responsesProvider))
    expect(out.max_output_tokens).toBe(512)
    expect('max_tokens' in out).toBe(false)
    expect('max_completion_tokens' in out).toBe(false)
  })

  test('no cap stays absent rather than becoming undefined-valued', async () => {
    const out = bodyOf(await t.transformRequestIn(unified({}), responsesProvider))
    expect('max_output_tokens' in out).toBe(false)
  })

  // The vendor rejects anything below 16. We forward it anyway: a proxy
  // that silently rewrites the caller's ceiling would answer differently
  // from the API it fronts, and the caller cannot see that it happened.
  test('forwards a below-minimum cap verbatim instead of clamping it', async () => {
    const out = bodyOf(await t.transformRequestIn(unified({ max_tokens: 8 }), responsesProvider))
    expect(out.max_output_tokens).toBe(8)
  })
})

// codex-oauth runs last and only for subscription providers, so it is
// the right place — and the only place — to drop the field for the one
// upstream that allow-lists top-level params.
class StubbedCodexTransformer extends CodexOauthTransformer {
  protected async resolveSubscriptionAuth(): Promise<OauthCredentials> {
    return { token: 'codex-access-token', accountId: 'acct_1' }
  }
}

describe('CodexOauthTransformer.transformRequestIn — output ceiling', () => {
  const codexProvider: RuntimeProvider = {
    name: 'codex',
    api_base_url: 'https://chatgpt.com/backend-api/codex',
    api_key: 'oauth'
  }
  // biome-ignore plugin: minimal TransformerContext stub — the transformer only reads req.headers for the session id.
  const ctx = { req: { headers: {} } } as unknown as TransformerContext

  test('strips max_output_tokens before the ChatGPT backend sees it', async () => {
    const t = new StubbedCodexTransformer()
    const hook = await t.transformRequestIn(unified({ max_output_tokens: 256 }), codexProvider, ctx)
    expect('max_output_tokens' in bodyOf(hook)).toBe(false)
  })
})

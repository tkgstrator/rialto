/**
 * POST /v1/messages/count_tokens — Anthropic's pre-flight size check.
 *
 * Claude Code calls this to decide when to compact a conversation. Without
 * it the caller gets Rialto's fail-closed 404 for unknown `/v1` paths, and
 * context management degrades silently — the client keeps sending until the
 * upstream refuses the request outright.
 *
 * **Counted locally, not proxied upstream.** A request that arrives on
 * `/v1/messages` may be served by GPT or Gemini, so asking Anthropic to
 * size it answers about a tokenizer that will not be used. The cost is
 * fidelity: this is Rialto's estimate, not Anthropic's exact count.
 *
 * Deliberately not an `InboundSurface`: nothing here is a completion, so it
 * has no transformer chain and no SSE aggregator. It sits in
 * `CATALOG_PATHS` beside `GET /v1/models` for the same reason — it still
 * needs the surface auth gate and the Anthropic error envelope.
 */

import { Hono } from 'hono'
import { TokenizerRegistry } from '@/llms/registry/tokenizer'
import type { RouterRequestBody } from '@/llms/router/types'
import { logger } from '@/logger'

export const countTokensRoute = new Hono()

/**
 * A tokenizer registry of its own, not the pipeline's.
 *
 * Reaching for `getLlmsContext()` would have been shorter, but it builds
 * the whole request-time context — provider registry, transformers,
 * config — and config reads Postgres. Counting tokens needs none of
 * that, and tying a pre-flight size check to the database means a
 * Postgres hiccup turns into a client that cannot decide when to
 * compact. (It also made this route untestable without a live DB, which
 * is how the coupling surfaced.)
 *
 * Built once and reused: `initialize()` loads the tokenizer, and doing
 * that per request would be the expensive part of an otherwise trivial
 * endpoint.
 */
const tokenizers: { value: TokenizerRegistry | null } = { value: null }

const getTokenizers = async (): Promise<TokenizerRegistry> => {
  if (tokenizers.value !== null) return tokenizers.value
  const built = new TokenizerRegistry(logger)
  await built.initialize()
  tokenizers.value = built
  return built
}

const errorEnvelope = (message: string) => ({
  type: 'error' as const,
  error: { type: 'invalid_request_error' as const, message }
})

countTokensRoute.post('/v1/messages/count_tokens', async (c) => {
  const parsed: unknown = await c.req.json().catch(() => null)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return c.json(errorEnvelope('Request body must be a JSON object'), 400)
  }

  // The body is not validated beyond being an object: the tokenizer already
  // tolerates every shape Claude Code sends, including server tools that
  // carry no `input_schema`, and rejecting a tool shape Rialto does not
  // model would break a request the upstream would have accepted.
  const body: RouterRequestBody = { model: '', ...parsed }

  const registry = await getTokenizers()
  const { tokenCount } = await registry.countTokens({
    messages: Array.isArray(body.messages) ? body.messages : [],
    system: body.system,
    tools: body.tools
  })

  // Anthropic's shape. `input_tokens` only — the endpoint does not report
  // cache or output figures.
  return c.json({ input_tokens: tokenCount })
})

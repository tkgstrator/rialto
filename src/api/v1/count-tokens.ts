/**
 * POST /v1/messages/count_tokens — Anthropic's pre-flight size check.
 *
 * Claude Code calls this to decide when to compact a conversation. Without
 * it the caller gets Rialto's fail-closed 404 for unknown `/v1` paths, and
 * context management degrades silently — the client keeps sending until the
 * upstream refuses the request outright.
 *
 * **Counted locally, not proxied upstream.** Two reasons, in order of
 * weight:
 *
 * 1. **The answer has to agree with the router.** The router's
 *    context-window gate counts the same request with the same registry
 *    (`scenario-router.ts` → `countRequestTokens`) and skips every route
 *    too small to hold it. If this endpoint asked Anthropic instead, a
 *    caller could be told it is comfortably under its limit while Rialto
 *    has already skipped routes as too small for it, or refused it — two
 *    numbers for one request, and no way for the operator to tell which
 *    one moved the traffic. Sharing `readSignals` makes them the same
 *    number by construction.
 * 2. **Rialto routes across vendors.** A request that arrives on
 *    `/v1/messages` may be served by GPT or Gemini. Asking Anthropic to
 *    size it answers about a tokenizer that will not be used.
 *
 * The cost is fidelity: this is Rialto's estimate, not Anthropic's exact
 * count. That is the same estimate the router already trusts to choose a
 * model, so a caller acting on it lands where Rialto would have put it.
 *
 * Deliberately not an `InboundSurface`: nothing here is a completion, so it
 * has no transformer chain, no SSE aggregator and no routing mode. It sits
 * in `CATALOG_PATHS` beside `GET /v1/models` for the same reason — it still
 * needs the surface auth gate and the Anthropic error envelope.
 */

import { Hono } from 'hono'
import { TokenizerRegistry } from '@/llms/registry/tokenizer'
import { readSignals } from '@/llms/scenario-router/surface-signals'
import type { RouterRequestBody } from '@/llms/scenario-router/types'
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

  // Read through the same extractor the router uses for this surface, so
  // the tokenize payload is byte-for-byte what the context-window gate
  // weighs. The body is not validated beyond being an object: the readers
  // already tolerate every shape Claude Code sends, including server tools
  // that carry no `input_schema`, and rejecting a tool shape Rialto does
  // not model would break a request the upstream would have accepted.
  const body: RouterRequestBody = { model: '', ...parsed }
  const { tokenize } = readSignals(body, '/v1/messages')

  const registry = await getTokenizers()
  const { tokenCount } = await registry.countTokens(tokenize)

  // Anthropic's shape. `input_tokens` only — the endpoint does not report
  // cache or output figures.
  return c.json({ input_tokens: tokenCount })
})

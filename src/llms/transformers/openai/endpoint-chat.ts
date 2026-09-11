/**
 * OpenAI endpoint transformer.
 *
 * Owns the `/v1/chat/completions` path. The endpoint conversion itself
 * is a pass-through — UnifiedChatRequest already matches OpenAI's wire
 * format — but when this transformer is mounted in a provider's
 * `transformer.use` chain it normalises the request for newer OpenAI
 * model families:
 *
 *   - gpt-5.x and o-series chat models reject `max_tokens` and require
 *     `max_completion_tokens` instead (HTTP 400 "Unsupported parameter").
 *     We rename the field in place, leaving older gpt-4.x models alone.
 *
 * Codex-family models on the openai provider are routed through
 * `openai-responses` — their `Model.apiStyle` disagrees with the
 * provider's, which earns them a per-model chain of their own (see
 * `shared/transformer-chain.ts`) — so they never reach this rewrite.
 */

import type { RuntimeProvider, TransformerContext, UnifiedChatRequest } from '@/schemas/domain'
import { REASONING_MODEL_RE } from '@/shared/reasoning-model'
import { absorbTopLevelSystem } from '../../utils/system-blocks'
import { liftToolResultImages } from '../../utils/tool-result-images'
import { Transformer } from '../base'

// gpt-5.x and o1/o3/o4 chat completions reject `max_tokens` in favour of
// `max_completion_tokens`. The check is intentionally narrow — gpt-4.x
// still uses the legacy field, and codex/Responses-only models are
// peeled off by the chain before we see them. The regex itself is
// shared with the frontend TierEditor via @/shared/constants so both
// surfaces stay in lock-step.
function modelNeedsMaxCompletionTokens(model: string | undefined): boolean {
  if (typeof model !== 'string' || model.length === 0) return false
  return REASONING_MODEL_RE.test(model)
}

export class OpenAITransformer extends Transformer {
  readonly name = 'openai'
  readonly endPoint = '/v1/chat/completions'

  // Endpoint-side inbound hook. /v1/chat/completions bodies mostly match
  // UnifiedChatRequest already, but two shape differences leak past a
  // pure passthrough:
  //
  //   - `reasoning_effort` (top-level scalar, OpenAI Chat wire form) →
  //     `reasoning: {effort}` (nested, unified). Every downstream reads
  //     the nested form; a client that sends the scalar form gets it
  //     silently dropped without this rewrite, or 400'd by strict
  //     upstreams (codex) that reject unknown top-level params.
  //   - `system` (top-level string / block array, Anthropic idiom).
  //     OpenAI callers never send this, but a persona-enriched pipeline
  //     could — absorb it into `messages[0]` defensively so nothing
  //     downstream sees a stray top-level field.
  //
  // Both mutations are idempotent (checks presence first) so a request
  // that already matches unified shape passes through untouched.
  async transformRequestOut(request: unknown, _context: TransformerContext): Promise<UnifiedChatRequest> {
    if (request === null || typeof request !== 'object') return request as UnifiedChatRequest
    const body = request as Record<string, unknown> & {
      messages?: Array<Record<string, unknown>>
      reasoning?: Record<string, unknown>
      reasoning_effort?: string
      system?: unknown
    }

    // Absorb Anthropic-style top-level `system` into a leading system
    // message. Supports both the string form and Anthropic's
    // block-array form (concatenate all text blocks). Idempotent —
    // a body whose messages[0] is already a system message is left
    // with only the top-level field stripped so retries don't
    // double-prepend the persona text.
    absorbTopLevelSystem(body)

    // Translate top-level `reasoning_effort` scalar into the nested
    // `reasoning.effort` unified shape so downstream provider chains
    // (openai-responses / codex-oauth) see it via the same field the
    // rest of the pipeline uses.
    if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.length > 0) {
      const existing = body.reasoning !== null && typeof body.reasoning === 'object' ? body.reasoning : {}
      if (existing.effort === undefined) {
        body.reasoning = { ...existing, effort: body.reasoning_effort }
      }
      delete body.reasoning_effort
    }

    return body as UnifiedChatRequest
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    _context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    const req = request as UnifiedChatRequest & {
      max_completion_tokens?: number
      reasoning_effort?: string
    }
    if (
      modelNeedsMaxCompletionTokens(req.model) &&
      typeof req.max_tokens === 'number' &&
      req.max_completion_tokens === undefined
    ) {
      req.max_completion_tokens = req.max_tokens
      // biome-ignore plugin: explicit removal of the unified-shape field — the upstream rejects it and the schema does not model field removal.
      delete (req as { max_tokens?: unknown }).max_tokens
    }
    const effort = provider.modelReasoningEfforts?.[req.model ?? '']
    if (effort && modelNeedsMaxCompletionTokens(req.model)) {
      // Chat Completions uses the top-level `reasoning_effort` field on
      // gpt-5.x / o-series models; other families ignore it, so gate on
      // the same predicate we use for max_completion_tokens.
      req.reasoning_effort = effort
    }
    // A tool message takes text only on this wire format.
    if (Array.isArray(req.messages)) req.messages = liftToolResultImages(req.messages)
    return req
  }
}

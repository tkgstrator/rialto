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
 *   - The Responses-only parts of unified — namespace and custom tools, and
 *     calls made into them — are lowered to function tools and calls
 *     (`utils/tool-lowering.ts`), because Chat has no place for them and
 *     a caller's Lite request declares nothing else.
 *
 * Any model on the provider that is served over Responses instead — a
 * codex-family model by default, or one the operator switched — has a
 * per-model chain of its own, because its `Model.apiStyle` disagrees with the
 * provider's (see `shared/transformer-chain.ts`). This step stands aside for
 * it (`hasOwnModelChain`), so none of the rewrites above touch its body.
 *
 * The provider's Base URL may name `/chat/completions` or `/responses`
 * (`utils/openai-endpoint.ts`); a request that stays on Chat goes to
 * `/chat/completions` either way.
 */

import type {
  RuntimeProvider,
  TransformerAuthResult,
  TransformerContext,
  TransformerHookResult,
  UnifiedChatRequest
} from '@/schemas/domain'
import { REASONING_MODEL_RE } from '@/shared/reasoning-model'
import { hasOwnModelChain } from '../../utils/model-chain'
import { redirectedOpenAIUrl } from '../../utils/openai-endpoint'
import { absorbTopLevelSystem } from '../../utils/system-blocks'
import { lowerResponsesTools } from '../../utils/tool-lowering'
import { liftToolResultImages } from '../../utils/tool-result-images'
import { Transformer } from '../base'

// gpt-5.x, gpt-6.x and o-series chat completions reject `max_tokens` in favour of
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

  // Bypass path: a `/v1/chat/completions` caller whose provider is a plain
  // Chat one skips the chain, and with it `transformRequestIn`. The body goes
  // through as it came, so only the URL is left to correct.
  async auth(request: unknown, provider: RuntimeProvider, _context: TransformerContext): Promise<unknown> {
    const url = redirectedOpenAIUrl(provider.api_base_url, 'chat')
    if (url === null) return request
    const result: TransformerAuthResult = { body: request, config: { url } }
    return result
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: RuntimeProvider,
    _context: TransformerContext
  ): Promise<TransformerHookResult | UnifiedChatRequest> {
    // Served over Responses, by a step that runs after this one and expects
    // the body still unified.
    if (hasOwnModelChain(provider, request.model)) return request
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
    if (modelNeedsMaxCompletionTokens(req.model)) {
      // Chat Completions takes a scalar, including when the inbound Chat
      // surface was normalised into unified reasoning by the endpoint hook.
      const clientEffort = req.reasoning?.effort
      if (effort && effort !== 'auto') req.reasoning_effort = effort
      else if (typeof clientEffort === 'string') req.reasoning_effort = clientEffort
    }
    // Chat rejects the unified Responses reasoning object.
    if ('reasoning' in req) delete req.reasoning
    // Chat Completions has no namespace or Responses-style custom tool, so
    // either sent verbatim is a 400 for the whole request — and dropped,
    // a Lite caller's model runs with no tools at all. Lowered, they are
    // functions the model can call; the Responses endpoint raises the
    // calls back to the shape the caller declared. A request that spoke
    // only in functions comes back as it went.
    const lowered = lowerResponsesTools(req)
    // A tool message takes text only on this wire format.
    const body = Array.isArray(lowered.messages)
      ? { ...lowered, messages: liftToolResultImages(lowered.messages) }
      : lowered
    const url = redirectedOpenAIUrl(provider.api_base_url, 'chat')
    return url === null ? body : { body, config: { url } }
  }
}

/**
 * Best-effort usage-row extraction from an upstream response clone.
 *
 * Parses either a blocking JSON body or an SSE stream for the usage
 * block and records it via `deps.recordUsage`. Never throws — callers
 * treat this as fire-and-forget so a parse failure never affects the
 * response the client actually receives.
 */

import {
  AnthropicMessageDeltaEventSchema,
  AnthropicMessageStartEventSchema,
  ChatCompletionUsageChunkSchema,
  GeminiUsageChunkSchema,
  type JsonResponseWithUsage,
  JsonResponseWithUsageSchema,
  ResponsesCompletedEventSchema,
  type TransformerContext,
  type UsageBlock,
  viewPipelineBody
} from '@/schemas/domain'
import type { ResolvedProvider } from '../registry/provider'
import { resolveSessionId } from './session-id'
import type { PipelineDeps } from './types'

export async function captureUsage(
  resp: Response,
  context: TransformerContext,
  provider: ResolvedProvider,
  body: unknown,
  status: number,
  durationMs: number,
  deps: PipelineDeps
): Promise<void> {
  const usage = await extractUsage(resp)
  if (!usage) return

  const sessionId = resolveSessionId(context)
  const tokens = computeTokenStats(usage)
  const view = viewPipelineBody(body)

  // The client's original model, the route that served it, and the
  // subagent flag all ride on context.req (stamped in
  // resolveInvocationForModel). requestedModel / route fall back to null
  // so a request that never went through routing still records a valid
  // row; isSubagent
  // is always known (defaults false at the route builder), so it stays a
  // plain boolean here.
  const requestedModel = context.req?.requestedModel
  const route = context.req?.route
  const isSubagent = context.req?.isSubagent === true
  const inboundType = context.req?.inboundType
  const surface = context.req?.surface
  const accessTokenId = context.req?.accessTokenId

  await deps.recordUsage?.({
    sessionId,
    provider: provider.name,
    model: view.model !== undefined ? view.model : 'unknown',
    requestedModel: requestedModel !== undefined ? requestedModel : null,
    scenario: route !== undefined ? route : null,
    inboundType: inboundType !== undefined ? inboundType : null,
    surface: surface !== undefined ? surface : null,
    accessTokenId: accessTokenId !== undefined ? accessTokenId : null,
    isSubagent,
    inputTokens: tokens.rawInput,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cachedTokens,
    cacheWriteTokens: tokens.writtenTokens,
    totalInputTokens: tokens.totalInputTokens,
    cacheHitPct: tokens.cacheHitPct,
    durationMs,
    status
  })
}

type TokenStats = {
  cachedTokens: number
  writtenTokens: number
  outputTokens: number
  rawInput: number
  totalInputTokens: number
  cacheHitPct: number
}

/**
 * Cached input tokens, plus whether the vendor already counted them
 * inside the input total it reported.
 *
 * The two conventions are opposites and have to be told apart before
 * anything is summed. Anthropic reports `input_tokens` as the
 * **non-cached remainder** and puts the cache hit beside it, so the
 * pieces add up. OpenAI documents `cached_tokens` as "cached tokens
 * present in the prompt" — a breakdown of `prompt_tokens` /
 * `input_tokens`, which already contains them. Adding the two for an
 * OpenAI response inflates the input of every cached request by exactly
 * the cached amount.
 *
 * Which surface a number came from is what identifies the convention:
 * `cache_read_input_tokens` is Anthropic's spelling, the two `*_details`
 * blocks are OpenAI's (Responses and Chat Completions respectively).
 */
type CachedInput = { tokens: number; countedInsideReportedInput: boolean }

function cachedInputTokens(usage: UsageBlock): CachedInput {
  const anthropic = numberOrZero(usage.cache_read_input_tokens)
  if (anthropic > 0) {
    return { tokens: anthropic, countedInsideReportedInput: false }
  }
  const responses = numberOrZero(usage.input_tokens_details?.cached_tokens)
  if (responses > 0) {
    return { tokens: responses, countedInsideReportedInput: true }
  }
  const chat = numberOrZero(usage.prompt_tokens_details?.cached_tokens)
  if (chat > 0) {
    return { tokens: chat, countedInsideReportedInput: true }
  }
  // Gemini follows OpenAI's convention, not Anthropic's.
  return { tokens: numberOrZero(usage.cachedContentTokenCount), countedInsideReportedInput: true }
}

function computeTokenStats(usage: UsageBlock): TokenStats {
  const cached = cachedInputTokens(usage)
  const writtenTokens = numberOrZero(usage.cache_creation_input_tokens)
  const outputTokens =
    numberOrZero(usage.output_tokens) ||
    numberOrZero(usage.completion_tokens) ||
    numberOrZero(usage.candidatesTokenCount)
  // Anthropic input_tokens is the non-cached portion only; OpenAI uses
  // prompt_tokens and Gemini promptTokenCount, both of which are totals.
  const reportedInput =
    numberOrZero(usage.input_tokens) || numberOrZero(usage.prompt_tokens) || numberOrZero(usage.promptTokenCount)
  // The row is written in Anthropic's convention — `inputTokens` is the
  // non-cached remainder and `totalInputTokens` is everything the prompt
  // cost — so an OpenAI total has to have its cached portion taken back
  // out before the pieces are re-added. Clamped at zero because a vendor
  // that ever reports a cache count larger than its own input total
  // should skew a row, not make it negative.
  const rawInput = cached.countedInsideReportedInput ? Math.max(reportedInput - cached.tokens, 0) : reportedInput
  const totalInputTokens = rawInput + writtenTokens + cached.tokens
  const cacheHitPct = totalInputTokens > 0 ? Math.round((cached.tokens / totalInputTokens) * 100) : 0
  return { cachedTokens: cached.tokens, writtenTokens, outputTokens, rawInput, totalInputTokens, cacheHitPct }
}

/** Coerce an optional `unknown` numeric usage field to a finite number, defaulting to 0. */
function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function extractUsage(resp: Response): Promise<UsageBlock | null> {
  try {
    const ct = resp.headers.get('content-type')
    const contentType = (typeof ct === 'string' ? ct : '').toLowerCase()
    if (contentType.includes('application/json')) {
      return await extractJsonUsage(resp)
    }
    // SSE or unknown content type — parse line-by-line.
    return await extractStreamUsage(resp)
  } catch {
    return null
  }
}

async function extractJsonUsage(resp: Response): Promise<UsageBlock | null> {
  const json = await resp.json().catch(() => null)
  const result = JsonResponseWithUsageSchema.safeParse(json)
  if (!result.success) return null
  return usageFromEnvelope(result.data)
}

/** `usage` (Anthropic / OpenAI) or `usageMetadata` (Gemini), whichever the upstream sent. */
function usageFromEnvelope(data: JsonResponseWithUsage): UsageBlock | null {
  if (data.usage !== undefined) return data.usage
  return data.usageMetadata !== undefined ? data.usageMetadata : null
}

async function extractStreamUsage(resp: Response): Promise<UsageBlock | null> {
  const text = await resp.text()
  let usage: UsageBlock | null = null
  for (const block of text.split('\n\n')) {
    usage = applySseBlock(block, usage)
  }
  if (!usage) usage = fallbackJsonParse(text)
  return usage
}

function applySseBlock(block: string, current: UsageBlock | null): UsageBlock | null {
  const dataLine = block.split('\n').find((l) => l.startsWith('data:'))
  if (!dataLine) return current
  const raw = dataLine.slice(5).trim()
  if (raw === '[DONE]') return current
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return current
  }

  const start = AnthropicMessageStartEventSchema.safeParse(obj)
  if (start.success) return { ...start.data.message.usage }

  const delta = AnthropicMessageDeltaEventSchema.safeParse(obj)
  if (delta.success) return { ...(current !== null ? current : {}), ...delta.data.usage }

  const completed = ResponsesCompletedEventSchema.safeParse(obj)
  if (completed.success) return { ...completed.data.response.usage }

  const chunk = ChatCompletionUsageChunkSchema.safeParse(obj)
  if (chunk.success) return { ...chunk.data.usage }

  // Gemini repeats cumulative counts on many chunks, so the last one wins.
  const gemini = GeminiUsageChunkSchema.safeParse(obj)
  if (gemini.success) return { ...gemini.data.usageMetadata }

  return current
}

function fallbackJsonParse(text: string): UsageBlock | null {
  try {
    const result = JsonResponseWithUsageSchema.safeParse(JSON.parse(text))
    if (result.success) return usageFromEnvelope(result.data)
  } catch {
    // not JSON
  }
  return null
}

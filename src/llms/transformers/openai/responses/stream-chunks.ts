/**
 * OpenAI Responses streaming chunk builders.
 *
 * Pure event -> chat-completion-chunk mapping, split out of
 * `response-stream.ts` (which owns the buffered SSE parsing session)
 * purely to keep that file under the line-count budget.
 */

import type { MessageContent } from '@/schemas/domain/unified'
import type { ResponsesStreamEvent } from '@/schemas/wire/openai/responses'
import { nowSeconds } from '../../../utils/time'
import { firstDefined, modelOr, newChatcmplId, stringDeltaOrEmpty } from './helpers'

export type StreamIndexState = {
  index: number
  lastEventType: string
}

function buildTextDeltaChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: { content: stringDeltaOrEmpty(data.delta) },
        finish_reason: null
      }
    ]
  }
}

function buildFunctionCallAddedChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  const item = data.item
  const toolName = item?.name
  if (toolName === undefined) {
    throw new Error('OpenAI Responses stream: function_call output is missing name')
  }
  const callId = firstDefined([item?.call_id, item?.id])
  return {
    id: newChatcmplId(callId),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model, 'gpt-5-codex-'),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: callId,
              function: {
                name: toolName,
                arguments: ''
              },
              type: 'function'
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

function buildMessageAddedChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> | null {
  const item = data.item
  if (!item) return null

  const contentItems: MessageContent[] = []
  const itemContent = item.content
  if (Array.isArray(itemContent)) {
    itemContent.forEach((entry) => {
      if (entry.type === 'output_text' && typeof entry.text === 'string') {
        contentItems.push({
          type: 'text',
          text: entry.text
        })
      }
    })
  }

  const delta: { role: string; content?: string | MessageContent[] } = { role: 'assistant' }
  if (contentItems.length === 1 && contentItems[0].type === 'text') {
    delta.content = contentItems[0].text
  } else if (contentItems.length > 0) {
    delta.content = contentItems
  }
  if (!delta.content) return null

  return {
    id: newChatcmplId(item.id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta,
        finish_reason: null
      }
    ]
  }
}

function buildAnnotationChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  // ResponsesAnnotationSchema fills missing fields with empty
  // defaults; if `annotation` itself is undefined we synthesise a
  // schema-shaped placeholder so the downstream emit stays uniform.
  const empty = { url: '', title: '', start_index: 0, end_index: 0 }
  const annotation = data.annotation ? data.annotation : empty
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model, 'gpt-5-codex'),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          annotations: [
            {
              type: 'url_citation',
              url_citation: {
                url: annotation.url,
                title: annotation.title,
                content: '',
                start_index: annotation.start_index,
                end_index: annotation.end_index
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

function buildFunctionArgsDeltaChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model, 'gpt-5-codex-'),
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: stringDeltaOrEmpty(data.delta)
              }
            }
          ]
        },
        finish_reason: null
      }
    ]
  }
}

function buildCompletedChunk(data: ResponsesStreamEvent, finishReasonOverride?: string): Record<string, unknown> {
  const inferred = data.response?.output?.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop'
  const finishReason = finishReasonOverride === undefined ? inferred : finishReasonOverride
  // Codex reports usage in Responses-API terms (input_tokens /
  // output_tokens / total_tokens). Emit the Chat-Completions
  // equivalent (prompt_tokens / completion_tokens / total_tokens) on
  // the terminal chunk so aggregate → chat.completion carries it and
  // the /v1/responses envelope carries its own usage block. Absent on
  // upstreams that don't publish usage — omit the field rather than
  // stamp zeros.
  const rawUsage: unknown = Reflect.get(data.response ?? {}, 'usage')
  const usage =
    rawUsage !== null && typeof rawUsage === 'object'
      ? {
          prompt_tokens: numericField(rawUsage, 'input_tokens', 0),
          completion_tokens: numericField(rawUsage, 'output_tokens', 0),
          total_tokens: numericField(rawUsage, 'total_tokens', 0),
          ...detailsField(rawUsage, 'input_tokens_details', 'prompt_tokens_details'),
          ...detailsField(rawUsage, 'output_tokens_details', 'completion_tokens_details')
        }
      : undefined
  const chunk: Record<string, unknown> = {
    id: newChatcmplId(data.response?.id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: modelOr(data.response?.model, 'gpt-5-codex-'),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason
      }
    ]
  }
  if (usage !== undefined) chunk.usage = usage
  return chunk
}

function numericField(source: unknown, key: string, fallback: number): number {
  if (source === null || typeof source !== 'object') return fallback
  const value = Reflect.get(source, key)
  return typeof value === 'number' ? value : fallback
}

/**
 * Carry a Responses usage detail block over under its Chat-Completions
 * name (`input_tokens_details` -> `prompt_tokens_details`, likewise for
 * output). Callers spread the result, so a missing block contributes
 * nothing rather than an explicit undefined.
 *
 * The block is forwarded whole instead of being rebuilt field by field:
 * `reasoning_tokens` and `cached_tokens` are the ones consumers ask for
 * today, but the shape grows over time and a passthrough keeps new
 * counters working without another release here.
 */
function detailsField(source: object, from: string, to: string): Record<string, object> {
  const value: unknown = Reflect.get(source, from)
  if (value === null || typeof value !== 'object') return {}
  return { [to]: value }
}

function buildReasoningDeltaChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex(data.type),
        delta: {
          thinking: {
            content: stringDeltaOrEmpty(data.delta)
          }
        },
        finish_reason: null
      }
    ]
  }
}

function buildReasoningSignatureChunk(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number
): Record<string, unknown> {
  // Use the same index as the most recent reasoning_summary_text delta
  // (the original code reused `currentIndex` without bumping). This
  // helper inspects the tracker without mutating it by passing the
  // type that already advanced it.
  return {
    id: newChatcmplId(data.item_id),
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: data.response?.model,
    choices: [
      {
        index: getCurrentIndex('response.reasoning_summary_text.delta'),
        delta: {
          thinking: {
            signature: data.item_id
          }
        },
        finish_reason: null
      }
    ]
  }
}

/**
 * The error `type` for a Responses failure `code`, in the taxonomy the
 * Anthropic and OpenAI envelopes share.
 *
 * The code is all the backend gives, and the type is what everything
 * downstream keys on: the Anthropic writer copies it onto its `error`
 * event, and the non-stream path recovers an HTTP status from it
 * (`statusForErrorEvent`). So a context overflow answers 400 and a spent
 * allowance 429, which a client knows to retry, instead of one failure
 * nobody can tell apart. The codes are the ones the Codex CLI itself
 * branches on; anything else is `api_error`.
 */
const FAILURE_TYPE_BY_CODE = new Map<string, string>([
  ['context_length_exceeded', 'invalid_request_error'],
  ['invalid_prompt', 'invalid_request_error'],
  ['bio_policy', 'invalid_request_error'],
  ['cyber_policy', 'invalid_request_error'],
  ['misalignment_policy_violation', 'invalid_request_error'],
  ['usage_not_included', 'permission_error'],
  ['rate_limit_exceeded', 'rate_limit_error'],
  ['insufficient_quota', 'rate_limit_error'],
  ['server_is_overloaded', 'overloaded_error'],
  ['slow_down', 'overloaded_error']
])

export type StreamFailure = { code: string | null; message: string }

const nonEmptyString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

/**
 * The code and message of a `response.failed` or `error` event.
 *
 * `response.failed` nests them under `response.error`; a bare `error`
 * event carries them at the top level, or under `error` on backends that
 * wrap it.
 */
export function failureOf(data: ResponsesStreamEvent): StreamFailure {
  const nested = data.type === 'response.failed' ? data.response?.error : data.error
  const source = nested === undefined || nested === null ? data : nested
  const code = nonEmptyString(source.code)
  const message = nonEmptyString(source.message)
  if (message !== null) return { code, message }
  const named = code === null ? data.type : `${data.type}: ${code}`
  return { code, message: `The upstream ended the response with ${named} and no message.` }
}

/**
 * An upstream failure as a chat chunk: the `{error:{…}}` payload an OpenAI
 * SDK throws on mid-stream, and the one the Anthropic writer turns into
 * an `error` event.
 */
function buildErrorChunk(failure: StreamFailure): Record<string, unknown> {
  const mapped = failure.code === null ? undefined : FAILURE_TYPE_BY_CODE.get(failure.code)
  return {
    error: {
      message: failure.message,
      type: mapped === undefined ? 'api_error' : mapped,
      code: failure.code,
      param: null
    }
  }
}

/**
 * `response.incomplete` is a truncation when the output budget ran out —
 * the text so far is the answer, cut short, which Chat calls `length` —
 * and a failure for any other reason.
 */
function handleIncomplete(data: ResponsesStreamEvent, enqueueChunk: (chunk: unknown) => void): void {
  const reason = nonEmptyString(data.response?.incomplete_details?.reason)
  if (reason === 'max_output_tokens') {
    enqueueChunk(buildCompletedChunk(data, 'length'))
    return
  }
  const named = reason === null ? 'no reason given' : `reason: ${reason}`
  enqueueChunk(buildErrorChunk({ code: reason, message: `The upstream returned an incomplete response (${named}).` }))
}

/**
 * Translates a single Responses-API SSE event into the chat-completion
 * chunk(s) the rest of the pipeline expects. Returns `true` when the
 * event indicates the stream is complete (so callers can suppress the
 * extra synthetic `[DONE]`).
 *
 * A failure ends the stream too, and has to be translated rather than
 * skipped: the Codex backend reports one only as an event on a stream
 * that already answered 200, so dropping it left a chat stream with no
 * chunks at all — which the Anthropic writer used to close as a message
 * with no start, and Claude Code reported as a malformed response from
 * "a proxy or gateway" instead of the upstream's own reason.
 */
export function handleStreamEvent(
  data: ResponsesStreamEvent,
  getCurrentIndex: (eventType: string) => number,
  enqueueChunk: (chunk: unknown) => void
): boolean {
  switch (data.type) {
    case 'response.output_text.delta':
      enqueueChunk(buildTextDeltaChunk(data, getCurrentIndex))
      return false
    case 'response.output_item.added':
      if (data.item?.type === 'function_call') {
        enqueueChunk(buildFunctionCallAddedChunk(data, getCurrentIndex))
      } else if (data.item?.type === 'message') {
        const chunk = buildMessageAddedChunk(data, getCurrentIndex)
        if (chunk) enqueueChunk(chunk)
      }
      return false
    case 'response.output_text.annotation.added':
      enqueueChunk(buildAnnotationChunk(data, getCurrentIndex))
      return false
    case 'response.function_call_arguments.delta':
      enqueueChunk(buildFunctionArgsDeltaChunk(data, getCurrentIndex))
      return false
    case 'response.completed':
      enqueueChunk(buildCompletedChunk(data))
      return true
    case 'response.failed':
    case 'error':
      enqueueChunk(buildErrorChunk(failureOf(data)))
      return true
    case 'response.incomplete':
      handleIncomplete(data, enqueueChunk)
      return true
    case 'response.reasoning_summary_text.delta':
      enqueueChunk(buildReasoningDeltaChunk(data, getCurrentIndex))
      return false
    case 'response.reasoning_summary_part.done':
      if (data.part) enqueueChunk(buildReasoningSignatureChunk(data, getCurrentIndex))
      return false
    default:
      return false
  }
}

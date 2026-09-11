/**
 * Per-chunk dispatch for the Anthropic SSE writer.
 *
 * `handleChunk` is the entry point the pump (`pump.ts`) calls for every
 * parsed OpenAI-shaped stream chunk; it fans out into the thinking /
 * text / annotation deltas here and the tool-call deltas in
 * `tool-calls.ts`.
 */

import { v4 } from 'uuid'
import { openaiToAnthropicStopReason } from '../../../utils/finish-reason'
import { computeUsage } from '../response-shared'
import { handleToolCallDelta } from './tool-calls'
import type { StreamChoiceDelta, StreamChunk, StreamState } from './types'

// The error types Anthropic's own envelope uses. One of them passes
// through; anything else is reported as `api_error`.
const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'api_error',
  'overloaded_error'
])

/**
 * An upstream failure as Anthropic's `error` event, and the end of the
 * stream.
 *
 * The payload is `{type:'error', error:{type, message}}` — the shape the
 * Anthropic SDK throws with, and the one `statusForErrorEvent` recovers a
 * status from on the non-stream path. It was sent under `message` with the
 * whole upstream object stringified into it, which neither reads.
 *
 * Nothing follows it. The writer's ordinary close appends message_delta
 * and message_stop, which would describe a failed message as one that
 * ended normally.
 */
function emitErrorAndClose(error: unknown, state: StreamState): void {
  const type = typeof error === 'object' && error !== null ? Reflect.get(error, 'type') : undefined
  const message = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : error
  const event = {
    type: 'error',
    error: {
      type: typeof type === 'string' && ANTHROPIC_ERROR_TYPES.has(type) ? type : 'api_error',
      message: typeof message === 'string' && message.length > 0 ? message : JSON.stringify(error)
    }
  }
  state.safeEnqueue(state.encoder.encode(`event: error\ndata: ${JSON.stringify(event)}\n\n`))
  state.closeWithoutStop()
}

export function handleChunk(chunk: StreamChunk, state: StreamState): boolean {
  if (chunk.error) {
    emitErrorAndClose(chunk.error, state)
    return true
  }

  if (chunk.model !== undefined) state.model = chunk.model

  emitMessageStartIfNeeded(state)

  const choice = chunk.choices?.[0]
  if (chunk.usage) {
    updateUsageDelta(chunk.usage, state)
  }
  if (!choice) return false

  handleThinkingDelta(choice.delta, state)
  handleTextDelta(choice.delta, state)
  handleAnnotationsDelta(choice.delta, state)
  handleToolCallDelta(choice.delta, state)

  if (choice.finish_reason && !state.isClosed && !state.hasFinished) {
    return handleFinishReason(choice.finish_reason, chunk.usage, state)
  }
  return false
}

function emitMessageStartIfNeeded(state: StreamState): void {
  if (state.hasStarted || state.isClosed || state.hasFinished) return
  state.hasStarted = true
  const messageStart = {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  }
  state.safeEnqueue(state.encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`))
}

function updateUsageDelta(usage: NonNullable<StreamChunk['usage']>, state: StreamState): void {
  const usageObj = computeUsage(usage)
  if (!state.stopReasonMessageDelta) {
    state.stopReasonMessageDelta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: usageObj
    }
    return
  }
  state.stopReasonMessageDelta.usage = usageObj
}

function handleThinkingDelta(delta: StreamChoiceDelta | undefined, state: StreamState): void {
  if (!delta?.thinking || state.isClosed || state.hasFinished) return
  if (!state.isThinkingStarted) {
    state.closeCurrentBlock()
    const thinkingBlockIndex = state.assignContentBlockIndex()
    const contentBlockStart = {
      type: 'content_block_start',
      index: thinkingBlockIndex,
      content_block: { type: 'thinking', thinking: '' }
    }
    state.safeEnqueue(
      state.encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`)
    )
    state.currentContentBlockIndex = thinkingBlockIndex
    state.isThinkingStarted = true
  }
  if (delta.thinking.signature) {
    const thinkingSignature = {
      type: 'content_block_delta',
      index: state.currentContentBlockIndex,
      delta: {
        type: 'signature_delta',
        signature: delta.thinking.signature
      }
    }
    state.safeEnqueue(
      state.encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(thinkingSignature)}\n\n`)
    )
    state.closeCurrentBlock()
    return
  }
  if (delta.thinking.content) {
    const thinkingChunk = {
      type: 'content_block_delta',
      index: state.currentContentBlockIndex,
      delta: {
        type: 'thinking_delta',
        thinking: delta.thinking.content
      }
    }
    state.safeEnqueue(state.encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(thinkingChunk)}\n\n`))
  }
}

function handleTextDelta(delta: StreamChoiceDelta | undefined, state: StreamState): void {
  if (!delta?.content || state.isClosed || state.hasFinished) return
  state.contentChunks++

  if (!state.hasTextContentStarted && !state.hasFinished) {
    state.closeCurrentBlock()
    const textBlockIndex = state.assignContentBlockIndex()
    const contentBlockStart = {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' }
    }
    state.safeEnqueue(
      state.encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`)
    )
    state.currentContentBlockIndex = textBlockIndex
    state.hasTextContentStarted = true
  }

  if (!state.isClosed && !state.hasFinished) {
    const anthropicChunk = {
      type: 'content_block_delta',
      index: state.currentContentBlockIndex,
      delta: { type: 'text_delta', text: delta.content }
    }
    state.safeEnqueue(state.encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(anthropicChunk)}\n\n`))
  }
}

function handleAnnotationsDelta(delta: StreamChoiceDelta | undefined, state: StreamState): void {
  if (!delta?.annotations?.length || state.isClosed || state.hasFinished) return
  state.closeCurrentBlock()

  for (const annotation of delta.annotations) {
    const annotationBlockIndex = state.assignContentBlockIndex()
    const title = annotation.url_citation?.title
    const url = annotation.url_citation?.url
    if (title === undefined || url === undefined) continue
    const contentBlockStart = {
      type: 'content_block_start',
      index: annotationBlockIndex,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: `srvtoolu_${v4()}`,
        content: [
          {
            type: 'web_search_result',
            title,
            url
          }
        ]
      }
    }
    state.safeEnqueue(
      state.encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`)
    )

    const contentBlockStop = {
      type: 'content_block_stop',
      index: annotationBlockIndex
    }
    state.safeEnqueue(state.encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`))
    state.currentContentBlockIndex = -1
  }
}

function handleFinishReason(finishReason: string, usage: StreamChunk['usage'], state: StreamState): boolean {
  if (state.contentChunks === 0 && state.toolCallChunks === 0) {
    console.error('Warning: No content in the stream response!')
  }

  if (state.currentContentBlockIndex >= 0) {
    const contentBlockStop = {
      type: 'content_block_stop',
      index: state.currentContentBlockIndex
    }
    state.safeEnqueue(state.encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`))
    state.currentContentBlockIndex = -1
  }

  if (!state.isClosed) {
    const anthropicStopReason = openaiToAnthropicStopReason(finishReason)
    state.stopReasonMessageDelta = {
      type: 'message_delta',
      delta: { stop_reason: anthropicStopReason, stop_sequence: null },
      usage: computeUsage(usage)
    }
  }

  return true
}

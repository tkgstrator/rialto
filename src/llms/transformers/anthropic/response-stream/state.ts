/**
 * Stream-state lifecycle: construction, safe enqueue/close, and
 * content-block open/close bookkeeping for the Anthropic SSE writer.
 */

import type { Logger } from 'pino'
import type { StreamState } from './types'

export function createStreamState(
  controller: ReadableStreamDefaultController<Uint8Array>,
  logger: Logger | undefined,
  reqId: string | undefined
): StreamState {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state: StreamState = {
    controller,
    encoder,
    decoder,
    messageId: `msg_${Date.now()}`,
    stopReasonMessageDelta: null,
    model: 'unknown',
    hasStarted: false,
    hasTextContentStarted: false,
    hasFinished: false,
    toolCalls: new Map(),
    toolCallIndexToContentBlockIndex: new Map(),
    totalChunks: 0,
    contentChunks: 0,
    toolCallChunks: 0,
    isClosed: false,
    isThinkingStarted: false,
    contentIndex: 0,
    currentContentBlockIndex: -1,
    safeEnqueue: () => {},
    safeClose: () => {},
    closeWithoutStop: () => {},
    closeCurrentBlock: () => {},
    assignContentBlockIndex: () => 0
  }

  state.safeEnqueue = (data: Uint8Array) => {
    safeEnqueue(state, data, logger, reqId)
  }
  state.safeClose = () => {
    safeClose(state)
  }
  state.closeWithoutStop = () => {
    closeWithoutStop(state)
  }
  state.closeCurrentBlock = () => {
    closeCurrentBlock(state)
  }
  state.assignContentBlockIndex = () => {
    const currentIdx = state.contentIndex
    state.contentIndex++
    return currentIdx
  }

  return state
}

function safeEnqueue(
  state: StreamState,
  data: Uint8Array,
  logger: Logger | undefined,
  reqId: string | undefined
): void {
  if (state.isClosed) return
  try {
    state.controller.enqueue(data)
    const dataStr = new TextDecoder().decode(data)
    logger?.trace({ reqId, data: dataStr, type: 'send data' })
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('Controller is already closed')) {
      state.isClosed = true
      return
    }
    logger?.debug({
      reqId,
      error: error instanceof Error ? error.message : String(error),
      type: 'send data error'
    })
    throw error
  }
}

// Close whatever content block is currently open and FULLY reset
// block state. Codex (openai-responses) interleaves multiple
// reasoning-summary segments with text and tool calls, so each
// block type can recur. Latching the started flags "true forever"
// made a later thinking or text delta reference an index that was
// never (re)opened, which Claude Code rejects with "Content block
// not found".
function closeCurrentBlock(state: StreamState): void {
  if (state.currentContentBlockIndex >= 0) {
    state.safeEnqueue(
      state.encoder.encode(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: state.currentContentBlockIndex
        })}\n\n`
      )
    )
  }
  state.currentContentBlockIndex = -1
  state.isThinkingStarted = false
  state.hasTextContentStarted = false
}

function emitFinalMessageDelta(state: StreamState): void {
  if (state.stopReasonMessageDelta) {
    state.safeEnqueue(
      state.encoder.encode(`event: message_delta\ndata: ${JSON.stringify(state.stopReasonMessageDelta)}\n\n`)
    )
    state.stopReasonMessageDelta = null
    return
  }
  state.safeEnqueue(
    state.encoder.encode(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0
        }
      })}\n\n`
    )
  )
}

// End the stream with nothing appended: after an error event, and for a
// stream that never started a message.
function closeWithoutStop(state: StreamState): void {
  if (state.isClosed) return
  try {
    state.controller.close()
  } catch (error) {
    if (!(error instanceof TypeError && error.message.includes('Controller is already closed'))) throw error
  }
  state.isClosed = true
}

function safeClose(state: StreamState): void {
  if (state.isClosed) return
  // No message_start went out, so there is no message to end. Closing it
  // with message_delta + message_stop anyway handed the client a
  // two-event husk ("Streaming response ended before any complete data")
  // and slipped past the route's zero-event check, which is what turns an
  // empty upstream into a real error status on the non-stream path.
  if (!state.hasStarted) {
    closeWithoutStop(state)
    return
  }
  try {
    if (state.currentContentBlockIndex >= 0) {
      const contentBlockStop = {
        type: 'content_block_stop',
        index: state.currentContentBlockIndex
      }
      state.safeEnqueue(
        state.encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
      )
      state.currentContentBlockIndex = -1
    }

    emitFinalMessageDelta(state)

    const messageStop = { type: 'message_stop' }
    state.safeEnqueue(state.encoder.encode(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`))
    state.controller.close()
    state.isClosed = true
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('Controller is already closed')) {
      state.isClosed = true
      return
    }
    throw error
  }
}

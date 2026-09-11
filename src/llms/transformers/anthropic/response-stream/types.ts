/**
 * Shared types for the Anthropic streaming (OpenAI SSE -> Anthropic SSE)
 * conversion machinery.
 */

export type StreamToolCallChunk = {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

export type StreamChoiceDelta = {
  content?: string
  thinking?: { content?: string; signature?: string }
  tool_calls?: StreamToolCallChunk[]
  annotations?: Array<{ url_citation?: { url?: string; title?: string } }>
}

export type StreamChunk = {
  model?: string
  error?: unknown
  choices?: Array<{
    delta?: StreamChoiceDelta
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

export type ToolCallInfo = {
  id: string
  name: string
  arguments: string
  contentBlockIndex: number
}

// Type guard: narrows the unknown stream payload to `StreamChunk`.
// The OpenAI streaming JSON is structurally compatible at runtime; the
// guard only checks that the shape looks like an object, leaving the
// optional field access to fail safely.
export function isStreamChunk(value: unknown): value is StreamChunk {
  return typeof value === 'object' && value !== null
}

export type StreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  decoder: TextDecoder
  messageId: string
  stopReasonMessageDelta: Record<string, unknown> | null
  model: string
  hasStarted: boolean
  hasTextContentStarted: boolean
  hasFinished: boolean
  toolCalls: Map<number, ToolCallInfo>
  toolCallIndexToContentBlockIndex: Map<number, number>
  totalChunks: number
  contentChunks: number
  toolCallChunks: number
  isClosed: boolean
  isThinkingStarted: boolean
  contentIndex: number
  currentContentBlockIndex: number
  safeEnqueue: (data: Uint8Array) => void
  safeClose: () => void
  closeWithoutStop: () => void
  closeCurrentBlock: () => void
  assignContentBlockIndex: () => number
}

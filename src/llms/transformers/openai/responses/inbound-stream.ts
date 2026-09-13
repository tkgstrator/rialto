/**
 * Chat-Completions SSE → Responses SSE, converted incrementally.
 *
 * The counterpart to `wrapResponsesEnvelopeAsSse` in `./inbound.ts`, and
 * the reason that one is now only a fallback. Both produce the same
 * event vocabulary; the difference is *when*. The wrapper needs a
 * finished envelope, so the `/v1/responses` endpoint had to fold the
 * whole upstream stream before writing its first byte — time to first
 * byte became time to last token.
 *
 * That is not merely a latency regression. A reverse proxy in front of
 * the gateway cannot tell a slow generation from a hung origin, so it
 * applies its own ceiling: Cloudflare, for one, terminates a request
 * whose origin has sent nothing for ~100s with a 524. Measured against
 * this gateway on the same model and prompt:
 *
 *   /v1/messages   (anthropic, incremental)  first_byte 0.67s  total 4.48s
 *   /v1/responses  (buffered)                first_byte 8.46s  total 8.46s
 *
 * The equality in the second row is the defect, and a long enough answer
 * turns it into a 524 that the client sees as a failed request. Writing
 * each event as it is derived keeps the connection demonstrably alive.
 *
 * The state machine mirrors `foldOpenAiChatChunks`
 * (`utils/sse-aggregate/openai-chat.ts`) chunk by chunk instead of all at
 * once: a `message` output item opened lazily on the first content
 * delta, one `function_call` / `custom_tool_call` item per
 * `tool_calls[].index`, and the accumulated envelope replayed on
 * `response.completed` so a client that ignores the deltas still sees
 * exactly what the buffered path used to hand it.
 */

import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import { isObject } from '../../../utils/guards'
import { nowSeconds } from '../../../utils/time'
import { convertChatUsageToResponses } from './inbound'

type ToolItem = {
  readonly id: string
  readonly outputIndex: number
  readonly kind: 'function' | 'custom'
  callId: string
  name: string
  payload: string
}

type MessageItem = {
  readonly id: string
  readonly outputIndex: number
  text: string
}

type ClosedItem = {
  readonly outputIndex: number
  readonly item: Record<string, unknown>
}

const hexId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`

/**
 * One upstream chat stream, converted as it arrives.
 *
 * A class rather than a closure for the same reason `ResponsesStreamSession`
 * is one: the accumulators outlive any single chunk, and each branch gets
 * to sit at its own cognitive-complexity score.
 */
class ChatToResponsesSession {
  private readonly controller: ReadableStreamDefaultController<Uint8Array>
  private readonly logger: Logger | undefined
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private readonly tools = new Map<number, ToolItem>()
  private readonly closed: ClosedItem[] = []
  private buffer = ''
  private opened = false
  private responseId = ''
  private createdAt = 0
  private model = ''
  private usage: Record<string, unknown> | undefined
  private message: MessageItem | null = null
  private nextOutputIndex = 0

  constructor(controller: ReadableStreamDefaultController<Uint8Array>, logger?: Logger) {
    this.controller = controller
    this.logger = logger
  }

  async run(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      await this.consume(reader)
      this.finish()
      this.controller.close()
    } catch (error) {
      this.logger?.error({ err: error }, 'chat→responses stream conversion failed')
      this.controller.error(error)
    } finally {
      try {
        reader.releaseLock()
      } catch (releaseError) {
        console.error(releaseError)
      }
    }
  }

  private async consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        const rest = this.buffer
        this.buffer = ''
        if (rest.length > 0) this.processLine(rest)
        return
      }
      this.buffer += this.decoder.decode(value, { stream: true })
      const lines = this.buffer.split(/\r?\n/)
      const remainder = lines.pop()
      this.buffer = typeof remainder === 'string' ? remainder : ''
      for (const line of lines) this.processLine(line)
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') return
    try {
      const parsed: unknown = JSON.parse(data)
      if (isObject(parsed)) this.handleChunk(parsed)
    } catch (parseError) {
      // Same forgiveness as the aggregators: a partial reconstruction
      // beats tearing down a stream the client is already reading.
      this.logger?.warn({ err: parseError, data }, 'dropped a malformed chat chunk')
    }
  }

  private handleChunk(chunk: Record<string, unknown>): void {
    this.absorbIdentity(chunk)
    this.open()
    const choices = chunk.choices
    if (!Array.isArray(choices)) return
    for (const raw of choices) {
      if (!isObject(raw)) continue
      // The Responses envelope has one `output`, and the JSON path
      // likewise reads `choices[0]`, so n>1 is dropped here rather than
      // interleaved into a single item list.
      const index = typeof raw.index === 'number' ? raw.index : 0
      if (index !== 0) continue
      const delta = raw.delta
      if (isObject(delta)) this.handleDelta(delta)
    }
  }

  private absorbIdentity(chunk: Record<string, unknown>): void {
    if (!this.opened) {
      if (typeof chunk.id === 'string' && chunk.id.length > 0) this.responseId = chunk.id
      if (typeof chunk.created === 'number') this.createdAt = chunk.created
    }
    if (this.model.length === 0 && typeof chunk.model === 'string') this.model = chunk.model
    // Usage rides the final chunk when the caller asked for it, so this
    // keeps overwriting rather than taking the first one seen.
    if (isObject(chunk.usage)) this.usage = chunk.usage
  }

  /**
   * Emit the opening pair. Deferred to the first chunk so `response.created`
   * can carry the upstream's own id and `created` — and so a stream that
   * never produces one event emits nothing at all, leaving the route's
   * zero-event warning to fire instead of a fabricated success.
   */
  private open(): void {
    if (this.opened) return
    if (this.responseId.length === 0) this.responseId = hexId('resp')
    if (this.createdAt === 0) this.createdAt = nowSeconds()
    this.opened = true
    const skeleton = this.envelope('in_progress', [])
    this.emit('response.created', { type: 'response.created', response: skeleton })
    this.emit('response.in_progress', { type: 'response.in_progress', response: skeleton })
  }

  private handleDelta(delta: Record<string, unknown>): void {
    const content = delta.content
    if (typeof content === 'string' && content.length > 0) this.pushText(content)
    const toolCalls = delta.tool_calls
    if (!Array.isArray(toolCalls)) return
    for (const raw of toolCalls) {
      if (isObject(raw)) this.pushToolCall(raw)
    }
  }

  private pushText(text: string): void {
    const item = this.openMessage()
    item.text += text
    this.emit('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      delta: text
    })
  }

  private openMessage(): MessageItem {
    const existing = this.message
    if (existing !== null) return existing
    const fresh: MessageItem = { id: hexId('msg'), outputIndex: this.nextOutputIndex++, text: '' }
    this.message = fresh
    this.emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: fresh.outputIndex,
      item: { id: fresh.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
    })
    return fresh
  }

  private pushToolCall(raw: Record<string, unknown>): void {
    const index = typeof raw.index === 'number' ? raw.index : 0
    const item = this.openToolCall(index, raw)
    if (typeof raw.id === 'string' && raw.id.length > 0) item.callId = raw.id
    const fn = raw.function
    if (!isObject(fn)) return
    if (typeof fn.name === 'string') item.name = fn.name
    const args = fn.arguments
    if (typeof args !== 'string' || args.length === 0) return
    item.payload += args
    // The custom kind has its own pair of events, and the Codex CLI reads
    // the call's text off them — a function_call_arguments pair here
    // would leave it with an empty command to run.
    const name =
      item.kind === 'custom' ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta'
    this.emit(name, { type: name, item_id: item.id, output_index: item.outputIndex, delta: args })
  }

  private openToolCall(index: number, raw: Record<string, unknown>): ToolItem {
    const existing = this.tools.get(index)
    if (existing !== undefined) return existing
    // A tool call ends the assistant's prose. Closing the message first
    // keeps items properly nested for a client that tracks open items.
    this.closeMessage()
    const kind = raw.type === 'custom' ? 'custom' : 'function'
    const fn = isObject(raw.function) ? raw.function : {}
    const fresh: ToolItem = {
      id: hexId(kind === 'custom' ? 'ctc' : 'fc'),
      outputIndex: this.nextOutputIndex++,
      kind,
      callId: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `call_${randomUUID().slice(0, 8)}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      payload: ''
    }
    this.tools.set(index, fresh)
    this.emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: fresh.outputIndex,
      item: this.toolItemShape(fresh, 'in_progress')
    })
    return fresh
  }

  private toolItemShape(item: ToolItem, status: string): Record<string, unknown> {
    return item.kind === 'custom'
      ? { id: item.id, type: 'custom_tool_call', status, call_id: item.callId, name: item.name, input: item.payload }
      : {
          id: item.id,
          type: 'function_call',
          status,
          call_id: item.callId,
          name: item.name,
          arguments: item.payload
        }
  }

  private closeMessage(): void {
    const item = this.message
    if (item === null) return
    this.message = null
    this.emit('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      text: item.text
    })
    const shape: Record<string, unknown> = {
      id: item.id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: item.text, annotations: [] }]
    }
    this.emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: item.outputIndex,
      item: shape
    })
    this.closed.push({ outputIndex: item.outputIndex, item: shape })
  }

  private closeToolCalls(): void {
    for (const [, item] of [...this.tools.entries()].sort(([a], [b]) => a - b)) {
      const doneName =
        item.kind === 'custom' ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done'
      const payload: Record<string, unknown> = {
        type: doneName,
        item_id: item.id,
        output_index: item.outputIndex
      }
      if (item.kind === 'custom') payload.input = item.payload
      else payload.arguments = item.payload
      this.emit(doneName, payload)
      const shape = this.toolItemShape(item, 'completed')
      this.emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: item.outputIndex,
        item: shape
      })
      this.closed.push({ outputIndex: item.outputIndex, item: shape })
    }
    this.tools.clear()
  }

  private finish(): void {
    if (!this.opened) return
    this.closeMessage()
    this.closeToolCalls()
    const output = [...this.closed].sort((a, b) => a.outputIndex - b.outputIndex).map((entry) => entry.item)
    this.emit('response.completed', { type: 'response.completed', response: this.envelope('completed', output) })
  }

  private envelope(status: string, output: Record<string, unknown>[]): Record<string, unknown> {
    const envelope: Record<string, unknown> = {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output
    }
    const usage = this.usage
    if (usage !== undefined) envelope.usage = convertChatUsageToResponses(usage)
    return envelope
  }

  private emit(name: string, payload: Record<string, unknown>): void {
    this.controller.enqueue(this.encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`))
  }
}

// The generated body no longer has the length or the encoding the
// upstream declared for its own.
function sseHeaders(source: Response): Headers {
  const headers = new Headers(source.headers)
  headers.set('content-type', 'text/event-stream')
  headers.set('cache-control', 'no-cache')
  headers.delete('content-length')
  headers.delete('content-encoding')
  return headers
}

/**
 * Convert a chat-completions SSE response into a Responses SSE response
 * without waiting for it to finish.
 *
 * Returns null when there is no body to read — the caller then falls
 * back to folding whatever it can, which is all that is left to do.
 */
export function convertChatSseToResponsesSse(response: Response, logger?: Logger): Response | null {
  const body = response.body
  if (body === null) return null
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const session = new ChatToResponsesSession(controller, logger)
      await session.run(body.getReader())
    }
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: sseHeaders(response)
  })
}

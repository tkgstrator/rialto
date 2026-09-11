/**
 * OpenAI Responses streaming SSE session.
 *
 * Buffered SSE parser that drives the upstream Responses-API stream and
 * dispatches each event through `handleStreamEvent` (the pure event ->
 * chunk(s) mapping in `./stream-chunks.ts`).
 */

import type { Logger } from 'pino'
import { type ResponsesStreamEvent, ResponsesStreamEventSchema } from '@/schemas/wire/openai/responses'
import { failureOf, handleStreamEvent } from './stream-chunks'

const FAILURE_EVENTS = new Set(['response.failed', 'response.incomplete', 'error'])

/** Does this `data:` payload look like a Responses-API event? */
function isResponsesEvent(dataStr: string): boolean {
  try {
    const raw: unknown = JSON.parse(dataStr)
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) return false
    return typeof raw.type === 'string' && raw.type.startsWith('response.')
  } catch {
    return false
  }
}

/**
 * Buffered SSE parser that drives the upstream Responses-API stream.
 *
 * Encapsulating this as a class keeps `handleStreamResponse` flat (one
 * `await session.run(...)` call) and lets each chunk-processing branch
 * sit at its own method-level cognitive complexity score.
 */
export class ResponsesStreamSession {
  private readonly controller: ReadableStreamDefaultController<Uint8Array>
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly logger: Logger | undefined
  private buffer = ''
  private isStreamEnded = false

  constructor(controller: ReadableStreamDefaultController<Uint8Array>, logger?: Logger) {
    this.controller = controller
    this.logger = logger
  }

  async run(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      await this.consume(reader)
      if (this.buffer.trim()) {
        this.enqueueRaw(this.buffer)
      }
      if (!this.isStreamEnded) {
        this.controller.enqueue(this.encoder.encode(`data: [DONE]\n\n`))
      }
    } catch (error) {
      console.error('Stream error:', error)
      this.controller.error(error)
    } finally {
      try {
        reader.releaseLock()
      } catch (e) {
        console.error('Error releasing reader lock:', e)
      }
      this.controller.close()
    }
  }

  private async consume(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        if (!this.isStreamEnded) {
          this.controller.enqueue(this.encoder.encode(`data: [DONE]\n\n`))
        }
        return
      }
      this.buffer += this.decoder.decode(value, { stream: true })
      const lines = this.buffer.split(/\r?\n/)
      const remainder = lines.pop()
      this.buffer = typeof remainder === 'string' ? remainder : ''
      for (const line of lines) {
        this.processLine(line)
      }
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) return
    try {
      if (line.startsWith('event: ')) return
      if (!line.startsWith('data: ')) {
        this.enqueueRaw(line)
        return
      }
      this.processDataLine(line)
    } catch (error) {
      console.error('Error processing line:', line, error)
      this.enqueueRaw(line)
    }
  }

  private processDataLine(line: string): void {
    const dataStr = line.slice(5).trim()
    if (dataStr === '[DONE]') {
      this.isStreamEnded = true
      this.controller.enqueue(this.encoder.encode(`data: [DONE]\n\n`))
      return
    }
    const parsed = this.safeParseEvent(dataStr)
    if (!parsed) {
      // This transformer emits a Chat-Completions stream. Forwarding an
      // unparsed Responses event verbatim breaks clients: the OpenAI SDK
      // reads every `data:` line as a chat chunk and throws on the first
      // `response.*` payload. Raw passthrough stays for anything that is
      // not a Responses event, so genuinely unknown wire data survives.
      if (!isResponsesEvent(dataStr)) this.enqueueRaw(line)
      return
    }
    if (FAILURE_EVENTS.has(parsed.type)) this.logFailure(parsed)
    const ended = handleStreamEvent(
      parsed,
      (eventType) => this.bumpIndex(eventType),
      (chunk) => this.enqueueChunk(chunk)
    )
    if (ended) this.isStreamEnded = true
  }

  // The response went out as a 200 before this event arrived, and a
  // stream carries no usage to write a request row from, so without a
  // line here the operator's only record of the request says it worked.
  private logFailure(event: ResponsesStreamEvent): void {
    const reason = event.response?.incomplete_details?.reason
    // A spent output budget is a truncated answer, not a failure.
    if (reason === 'max_output_tokens') return
    const failure = failureOf(event)
    this.logger?.warn(
      { event: event.type, code: failure.code, reason, message: failure.message },
      'upstream responses stream ended in a failure after answering 200'
    )
  }

  private safeParseEvent(dataStr: string): ResponsesStreamEvent | null {
    let raw: unknown
    try {
      raw = JSON.parse(dataStr)
    } catch {
      return null
    }
    const result = ResponsesStreamEventSchema.safeParse(raw)
    return result.success ? result.data : null
  }

  private bumpIndex(_eventType: string): number {
    // choices[].index is always 0 for an OpenAI Chat-Completions stream
    // with n=1 (the only shape the pipeline supports). The previous
    // implementation incremented on every distinct upstream event type,
    // so a codex reply carrying reasoning items ahead of the message
    // emitted text-delta chunks at index=N while buildCompletedChunk
    // hardcoded index=0. Aggregating to the non-stream envelope produced
    // two choices — choices[0]={content:'', finish_reason:'stop'} and
    // choices[N]={content:'…', finish_reason:null} — so OpenAI SDKs
    // (which read choices[0].message.content) reported an empty
    // response. The same misalignment made convertChatCompletionToResponses
    // hand back `output:[]` because chat.choices[0].message.content was
    // the empty one. The parameter stays so the stream-chunks call
    // sites don't need to change.
    return 0
  }

  private enqueueChunk(obj: unknown): void {
    this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
  }

  private enqueueRaw(text: string): void {
    this.controller.enqueue(this.encoder.encode(`${text}\n`))
  }
}

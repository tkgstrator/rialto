/**
 * Anthropic Messages SSE → Chat Completions SSE, converted incrementally —
 * and `convertAnthropicReplyToChat`, the response hook both Claude steps
 * (`anthropic`, `claude-code-oauth`) run on the conversion path.
 *
 * The streaming counterpart of `./response-to-chat.ts`. Most clients of an
 * OpenAI surface stream (the Codex CLI always does), and an Anthropic
 * stream relayed as-is reaches them as events no OpenAI parser reads: the
 * surface's own converter (`inbound-stream.ts` for Responses, the Gemini
 * writer) needs Chat chunks to work from. Converted event by event, so the
 * client's first byte leaves with the upstream's first token — buffering
 * the stream would turn time-to-first-byte into time-to-last-token, and a
 * long answer into a reverse proxy's idle timeout (see `inbound-stream.ts`).
 *
 * Event by event:
 *
 *   message_start          the role chunk; the id, model and input usage
 *   content_block_start    text: nothing yet; tool_use: the call's opening
 *                          chunk (`tool_calls[{index, id, name}]`); thinking:
 *                          nothing yet; anything else (server tool calls
 *                          and results, redacted thinking) is Anthropic's
 *                          own business and is skipped with its deltas
 *   content_block_delta    text_delta → `content`; input_json_delta → the
 *                          call's `arguments`; thinking_delta /
 *                          signature_delta → `thinking.{content,signature}`,
 *                          the field the Responses and Gemini converters
 *                          use for reasoning on a chat chunk
 *   content_block_stop     a tool call that streamed no input closes as `{}`
 *   message_delta          finish_reason and the usage, on one chunk
 *   message_stop           `[DONE]`
 *   error                  the `{error:{message,type,code,param}}` chunk
 *                          the Responses → Chat converter writes for an
 *                          upstream failure, and nothing after it
 *   ping                   nothing
 *
 * Tool calls are numbered among themselves (`tool_calls[].index`), not by
 * the Anthropic block index that also counts text and thinking.
 *
 * An event that is not Anthropic's is forwarded verbatim: the hook may sit
 * on a chain whose upstream speaks Chat (an API-key provider with a model
 * routed to another wire format), and the blocking path likewise hands
 * back anything that is not an Anthropic envelope untouched.
 */

import type { Logger } from 'pino'
import { anthropicToOpenAiFinishReason } from '../../utils/finish-reason'
import { isObject } from '../../utils/guards'
import { cloneResponse } from '../../utils/response-clone'
import { isSseContentType } from '../../utils/sse-aggregate'
import { nowSeconds } from '../../utils/time'
import { chatUsageOf, convertAnthropicResponseToChat, isAnthropicMessageResponse } from './response-to-chat'

const ANTHROPIC_EVENTS: ReadonlySet<unknown> = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error'
])

type OpenBlock =
  | { readonly kind: 'text' | 'thinking' | 'skipped' }
  | { readonly kind: 'tool'; readonly toolIndex: number; inputStreamed: boolean }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

class AnthropicToChatSession {
  private readonly controller: ReadableStreamDefaultController<Uint8Array>
  private readonly logger: Logger | undefined
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private readonly blocks = new Map<number, OpenBlock>()
  private buffer = ''
  private started = false
  private ended = false
  private id = ''
  private model = ''
  private created = 0
  private usage: Record<string, unknown> = {}
  private nextToolIndex = 0

  constructor(controller: ReadableStreamDefaultController<Uint8Array>, logger?: Logger) {
    this.controller = controller
    this.logger = logger
  }

  async run(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      await this.consume(reader)
      // Cut off before `message_stop`: close the chat stream the way it
      // would have closed, with whatever arrived. A stream that never
      // started stays empty, so the route still sees a stream with no
      // usable event rather than a fabricated success.
      if (this.started && !this.ended) this.emitData('[DONE]')
      this.controller.close()
    } catch (error) {
      this.logger?.error({ err: error }, 'anthropic→chat stream conversion failed')
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

  // Anthropic writes each event as `event:` + one `data:` line; the type in
  // the JSON is authoritative, so only the data line is read.
  private processLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data.length === 0) return
    // Anthropic never sends it; a Chat stream passing through does.
    if (data === '[DONE]') {
      this.emitData(data)
      return
    }
    const event = this.parse(data)
    if (isObject(event) && ANTHROPIC_EVENTS.has(event.type)) this.handleEvent(event)
    else this.emitData(data)
  }

  private parse(data: string): unknown {
    try {
      return JSON.parse(data)
    } catch (parseError) {
      // A partial reconstruction beats tearing down a stream the client is
      // already reading — the same forgiveness as the aggregators.
      this.logger?.warn({ err: parseError, data }, 'dropped a malformed anthropic event')
      return undefined
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (this.ended) return
    switch (event.type) {
      case 'message_start':
        this.start(event.message)
        return
      case 'content_block_start':
        this.openBlock(event.index, event.content_block)
        return
      case 'content_block_delta':
        this.delta(event.index, event.delta)
        return
      case 'content_block_stop':
        this.closeBlock(event.index)
        return
      case 'message_delta':
        this.finish(event.delta, event.usage)
        return
      case 'message_stop':
        this.ended = true
        this.emitData('[DONE]')
        return
      case 'error':
        this.fail(event.error)
        return
      default:
        // ping
        return
    }
  }

  private start(message: unknown): void {
    const shape = isObject(message) ? message : {}
    this.id = text(shape.id)
    this.model = text(shape.model)
    this.created = nowSeconds()
    this.absorbUsage(shape.usage)
    this.started = true
    this.chunk({ role: 'assistant', content: '' })
  }

  // Counts arrive in pieces — input and cache on `message_start`, output
  // (and on newer responses the input again) on `message_delta` — and each
  // later count supersedes the one before.
  private absorbUsage(usage: unknown): void {
    if (!isObject(usage)) return
    const counts = Object.entries(usage).filter(([, value]) => typeof value === 'number')
    this.usage = { ...this.usage, ...Object.fromEntries(counts) }
  }

  private openBlock(index: unknown, block: unknown): void {
    if (typeof index !== 'number' || !isObject(block)) return
    if (block.type === 'text') {
      this.blocks.set(index, { kind: 'text' })
      if (text(block.text).length > 0) this.chunk({ content: block.text })
      return
    }
    if (block.type === 'thinking') {
      this.blocks.set(index, { kind: 'thinking' })
      if (text(block.thinking).length > 0) this.chunk({ thinking: { content: block.thinking } })
      return
    }
    if (block.type !== 'tool_use') {
      this.blocks.set(index, { kind: 'skipped' })
      return
    }
    const toolIndex = this.nextToolIndex++
    this.blocks.set(index, { kind: 'tool', toolIndex, inputStreamed: false })
    const call = {
      index: toolIndex,
      id: text(block.id),
      type: 'function',
      function: { name: text(block.name), arguments: '' }
    }
    this.chunk({ tool_calls: [call] })
  }

  private delta(index: unknown, delta: unknown): void {
    const block = typeof index === 'number' ? this.blocks.get(index) : undefined
    if (block === undefined || !isObject(delta)) return
    if (block.kind === 'text' && delta.type === 'text_delta' && text(delta.text).length > 0) {
      this.chunk({ content: delta.text })
      return
    }
    if (block.kind === 'thinking' && delta.type === 'thinking_delta' && text(delta.thinking).length > 0) {
      this.chunk({ thinking: { content: delta.thinking } })
      return
    }
    if (block.kind === 'thinking' && delta.type === 'signature_delta' && text(delta.signature).length > 0) {
      this.chunk({ thinking: { signature: delta.signature } })
      return
    }
    if (block.kind === 'tool' && delta.type === 'input_json_delta' && text(delta.partial_json).length > 0) {
      block.inputStreamed = true
      this.chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] })
    }
  }

  // A tool with no parameters can close without one input fragment; a
  // call with empty arguments is not valid JSON to a client that parses
  // them, so it closes as the empty object Anthropic called it with.
  private closeBlock(index: unknown): void {
    const block = typeof index === 'number' ? this.blocks.get(index) : undefined
    if (block?.kind !== 'tool' || block.inputStreamed) return
    this.chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: '{}' } }] })
  }

  private finish(delta: unknown, usage: unknown): void {
    this.absorbUsage(usage)
    const stopReason = isObject(delta) && typeof delta.stop_reason === 'string' ? delta.stop_reason : null
    this.chunk({}, anthropicToOpenAiFinishReason(stopReason), chatUsageOf(this.usage))
  }

  // An `error` event arrives on a stream that already answered 200 —
  // `overloaded_error` mid-answer is the usual one. Anthropic's error types
  // are the taxonomy the chat error chunk already carries, so the type
  // passes through, and `findSseStreamDefect` maps it back to a status for
  // a non-stream caller. Logged, because a stream writes no request row.
  private fail(error: unknown): void {
    const shape = isObject(error) ? error : {}
    const type = text(shape.type).length > 0 ? text(shape.type) : 'api_error'
    const message =
      text(shape.message).length > 0 ? text(shape.message) : `The upstream ended the response with ${type}.`
    this.logger?.warn({ type, message }, 'upstream anthropic stream ended in an error after answering 200')
    this.ended = true
    this.emitData(JSON.stringify({ error: { message, type, code: null, param: null } }))
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>) {
    const payload: Record<string, unknown> = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    }
    if (usage !== undefined) payload.usage = usage
    this.emitData(JSON.stringify(payload))
  }

  private emitData(data: string): void {
    this.controller.enqueue(this.encoder.encode(`data: ${data}\n\n`))
  }
}

// The converted body no longer has the length or the encoding the upstream
// declared for its own.
function sseHeaders(source: Response): Headers {
  const headers = new Headers(source.headers)
  headers.set('content-type', 'text/event-stream')
  headers.set('cache-control', 'no-cache')
  headers.delete('content-length')
  headers.delete('content-encoding')
  return headers
}

/**
 * Convert an Anthropic SSE response into a Chat Completions SSE response
 * without waiting for it to finish. Null when there is no body to read.
 */
export function convertAnthropicSseToChatSse(response: Response, logger?: Logger): Response | null {
  const body = response.body
  if (body === null) return null
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new AnthropicToChatSession(controller, logger).run(body.getReader())
    }
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: sseHeaders(response)
  })
}

/**
 * An Anthropic reply, streamed or not, in Chat Completions shape — the
 * `transformResponseOut` of both Claude steps on the conversion path.
 *
 * Bypass never reaches it (`/v1/messages` callers get the raw Anthropic
 * response), and neither does an upstream error, which `sendToProvider`
 * has already raised. A body that is not Anthropic's goes back as it came.
 */
export async function convertAnthropicReplyToChat(response: Response, logger?: Logger): Promise<Response> {
  if (!response.ok) return response
  if (isSseContentType(response.headers.get('content-type'))) {
    const streamed = convertAnthropicSseToChatSse(response, logger)
    return streamed === null ? response : streamed
  }
  const raw = await response.text()
  if (raw.length === 0) return cloneResponse(response, raw)
  const parsed = parseJson(raw)
  // Non-JSON (upstream text, a fronting proxy's HTML) and envelopes that
  // are not Anthropic's are handed back untouched: rewrapping them would
  // hide what the upstream said.
  if (!isAnthropicMessageResponse(parsed)) return cloneResponse(response, raw)
  return cloneResponse(response, JSON.stringify(convertAnthropicResponseToChat(parsed)))
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

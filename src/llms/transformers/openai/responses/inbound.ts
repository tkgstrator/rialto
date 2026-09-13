/**
 * OpenAI Responses inbound converters.
 *
 * The `/v1/responses` endpoint transformer uses these to invert what
 * the OUTBOUND path (request.ts / response-json.ts) does:
 *
 *   - request:   Responses shape (`input`, `instructions`, flat tools)
 *                → UnifiedChatRequest (`messages`, nested tools)
 *   - response:  chat.completion JSON → Responses `response` envelope
 *   - SSE:       chat.completion SSE  → Responses SSE. The incremental
 *                converter lives in `./inbound-stream.ts`;
 *                `wrapResponsesEnvelopeAsSse` below is the fallback for
 *                a response with no readable body.
 *
 * Kept minimal: text, tools, both tool-call kinds (function_call /
 * custom_tool_call and their outputs), and input images are supported.
 * Uncommon shapes (audio, refusal, custom annotations) round-trip through
 * the pipeline verbatim rather than throwing, so the upstream error
 * surfaces to the caller instead of a schema violation here.
 */

import { randomUUID } from 'node:crypto'
import type { UnifiedChatRequest } from '@/schemas/domain/unified'
import {
  type ChatCompletionResponse,
  type ChatCompletionResponseMessage,
  ResponsesInboundCustomToolCallItemSchema,
  ResponsesInboundCustomToolCallOutputItemSchema,
  ResponsesInboundFunctionCallItemSchema,
  ResponsesInboundFunctionCallOutputItemSchema,
  type ResponsesInboundMessageItem,
  ResponsesInboundMessageItemSchema
} from '@/schemas/wire'
import { isObject } from '../../../utils/guards'
import { flattenSystemToText } from '../../../utils/system-blocks'
import { nowSeconds } from '../../../utils/time'

// ─── Request: Responses → UnifiedChatRequest ───────────────────────────

function contentTextParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (!isObject(item)) continue
    const t = item.type
    if ((t === 'input_text' || t === 'output_text' || t === 'text') && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.join('')
}

function contentImageParts(content: unknown): Array<{ type: 'image_url'; image_url: { url: string } }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ type: 'image_url'; image_url: { url: string } }> = []
  for (const item of content) {
    if (!isObject(item)) continue
    if (item.type !== 'input_image' && item.type !== 'image_url') continue
    // Responses uses `image_url` as a bare URL string, Chat uses
    // `image_url: { url }`. Accept both.
    const raw = item.image_url
    const url = typeof raw === 'string' ? raw : isObject(raw) && typeof raw.url === 'string' ? raw.url : undefined
    if (typeof url === 'string' && url.length > 0) {
      out.push({ type: 'image_url', image_url: { url } })
    }
  }
  return out
}

function convertMessageItem(item: ResponsesInboundMessageItem): Record<string, unknown> | null {
  const role = typeof item.role === 'string' && item.role.length > 0 ? item.role : 'user'
  const text = contentTextParts(item.content)
  const images = contentImageParts(item.content)
  if (images.length === 0 && text.length === 0 && typeof item.content !== 'string') return null
  if (images.length === 0) return { role, content: text }
  // Multimodal: chat-completions represents mixed content as an array of
  // {type:'text'|'image_url', ...} blocks.
  const blocks: Array<Record<string, unknown>> = []
  if (text.length > 0) blocks.push({ type: 'text', text })
  blocks.push(...images)
  return { role, content: blocks }
}

// An assistant turn that called a tool, in the one shape chat-completions
// has for both kinds. `payload` is the call's arguments (JSON, for the
// function kind) or its input (free text, for the custom kind); `kind` is
// what lets the outbound side put it back under the right name.
function toolCallMessage(
  ids: { call_id?: string; id?: string },
  kind: 'function' | 'custom',
  name: string,
  payload: string
): Record<string, unknown> {
  const id = ids.call_id ?? ids.id ?? `call_${randomUUID().slice(0, 8)}`
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: kind, function: { name, arguments: payload } }]
  }
}

// The result of having run one, likewise. `tool_call_type` rides along
// only for the custom kind so that a function result stays byte-identical
// to what every caller before custom tools produced.
function toolResultMessage(callId: string | undefined, kind: 'function' | 'custom', output: unknown) {
  const content = typeof output === 'string' ? output : output !== undefined ? JSON.stringify(output) : ''
  const message: Record<string, unknown> = { role: 'tool', tool_call_id: callId ?? '', content }
  if (kind === 'custom') message.tool_call_type = kind
  return message
}

function convertToolsResponsesToChat(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined
  const out: unknown[] = []
  for (const raw of tools) {
    if (!isObject(raw)) continue
    if (raw.type === 'web_search') {
      // The Chat wire form of a hosted web-search tool is a function
      // whose name is literally "web_search"; remapTools on the other
      // side collapses it back to `{type:'web_search'}`.
      out.push({
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Hosted web search',
          parameters: { type: 'object', properties: {} }
        }
      })
      continue
    }
    if (raw.type !== 'function') {
      // A tool with no Chat-Completions equivalent — Codex's `namespace`,
      // `custom` and `local_shell`. Carry it verbatim: the unified type has a
      // member for exactly this (UnifiedPassthroughTool), so each
      // outbound transformer decides what its own upstream can do with
      // it rather than us dropping it here.
      out.push(raw)
      continue
    }
    const name = typeof raw.name === 'string' ? raw.name : undefined
    if (name === undefined) continue
    const parameters = isObject(raw.parameters) ? raw.parameters : { type: 'object', properties: {} }
    const description = typeof raw.description === 'string' ? raw.description : undefined
    const fn: Record<string, unknown> = { name, parameters }
    if (description !== undefined) fn.description = description
    out.push({ type: 'function', function: fn })
  }
  return out
}

function convertToolChoiceResponsesToChat(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (!isObject(choice)) return choice
  if (choice.type === 'web_search') return { type: 'function', function: { name: 'web_search' } }
  if (choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  return choice
}

// Rewrite an incoming /v1/responses body into a UnifiedChatRequest. The
// original body may still carry `input`, `instructions`, `parallel_tool_calls`
// etc — we strip those to keep the downstream provider chain from
// double-processing them.
export function convertResponsesRequestToUnified(body: Record<string, unknown>): UnifiedChatRequest {
  const model = typeof body.model === 'string' ? body.model : ''
  const messages: Array<Record<string, unknown>> = []

  // `instructions` is Responses' top-level system prompt.
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    if (input.length > 0) messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (!isObject(raw)) continue

      const fc = ResponsesInboundFunctionCallItemSchema.safeParse(raw)
      if (fc.success) {
        messages.push(toolCallMessage(fc.data, 'function', fc.data.name ?? '', fc.data.arguments ?? ''))
        continue
      }

      const fco = ResponsesInboundFunctionCallOutputItemSchema.safeParse(raw)
      if (fco.success) {
        messages.push(toolResultMessage(fco.data.call_id, 'function', fco.data.output))
        continue
      }

      const ctc = ResponsesInboundCustomToolCallItemSchema.safeParse(raw)
      if (ctc.success) {
        messages.push(toolCallMessage(ctc.data, 'custom', ctc.data.name ?? '', ctc.data.input ?? ''))
        continue
      }

      const ctco = ResponsesInboundCustomToolCallOutputItemSchema.safeParse(raw)
      if (ctco.success) {
        messages.push(toolResultMessage(ctco.data.call_id, 'custom', ctco.data.output))
        continue
      }

      const msgItem = ResponsesInboundMessageItemSchema.safeParse(raw)
      if (msgItem.success) {
        const msg = convertMessageItem(msgItem.data)
        if (msg) messages.push(msg)
      }
      // Unknown item type — skip; the caller will get an empty pipeline
      // if the whole input was unknown, which surfaces as "no messages"
      // rather than a schema violation.
    }
  }

  // Absorb an Anthropic-style top-level `system` (Responses API doesn't
  // model it, but a persona-enriched pipeline could still leave one) as
  // a leading system message. Matches OpenAITransformer.transformRequestOut.
  const systemText = body.system !== undefined && body.system !== null ? flattenSystemToText(body.system) : ''
  if (systemText.length > 0 && (messages.length === 0 || messages[0]?.role !== 'system')) {
    messages.unshift({ role: 'system', content: systemText })
  }

  const tools = convertToolsResponsesToChat(body.tools)
  const toolChoice = convertToolChoiceResponsesToChat(body.tool_choice)

  const unified: Record<string, unknown> = { ...body, model, messages }
  if (tools !== undefined) unified.tools = tools
  if (toolChoice !== undefined) unified.tool_choice = toolChoice
  // The output cap is the one field whose name differs on every surface:
  // Responses spells it `max_output_tokens`, unified and chat-completions
  // spell it `max_tokens`, and newer gpt-5.x chat models want
  // `max_completion_tokens` (endpoint-chat.ts renames it further down).
  // Absorb it into the unified name so the rest of the pipeline sees one
  // spelling and each outbound transformer can re-emit the one its own
  // upstream takes.
  //
  // Left alone it rides `...body` untouched to whatever upstream the
  // chain picked, which is only correct for a Responses upstream. Against
  // chat/completions it is a hard failure: api.openai.com answers 400
  // "Unknown parameter: 'max_output_tokens'" (measured), and the codex
  // backend was reported answering 400 "Unsupported parameter" (#463).
  //
  // An explicit `max_tokens` wins, on the same "caller was more specific"
  // rule as `tools`.
  if (typeof body.max_output_tokens === 'number' && unified.max_tokens === undefined) {
    unified.max_tokens = body.max_output_tokens
  }
  // These fields are Responses-only or already absorbed above; strip so
  // downstream `openai` / `anthropic` transformers don't see stray keys.
  delete unified.input
  delete unified.instructions
  delete unified.max_output_tokens
  delete unified.parallel_tool_calls
  delete unified.previous_response_id
  delete unified.store
  delete unified.system
  // `reasoning` is compatible: unified accepts `{effort, ...}` and
  // downstream transformers strip fields they don't know.
  // biome-ignore plugin: we intentionally widen the record back to UnifiedChatRequest — the shape is now unified-compatible.
  return unified as unknown as UnifiedChatRequest
}

// ─── Response: chat.completion JSON → Responses envelope ───────────────

function buildResponsesOutputItems(message: ChatCompletionResponseMessage | undefined): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  const content = message?.content
  const text = typeof content === 'string' ? content : contentTextParts(content)
  if (text.length > 0) {
    items.push({
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: message?.role ?? 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      const callId = tc.id ?? `call_${randomUUID().slice(0, 8)}`
      const name = tc.function?.name ?? ''
      const payload = tc.function?.arguments ?? ''
      // A custom tool's call is a different output item, not a
      // `function_call` with a different payload: the Codex CLI reads
      // `input`, and the upstream expects the matching
      // `custom_tool_call_output` on the next turn.
      if (tc.type === 'custom') {
        items.push({
          id: `ctc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: callId,
          name,
          input: payload
        })
        continue
      }
      items.push({
        id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name,
        arguments: payload
      })
    }
  }
  return items
}

/**
 * The one field rename the two surfaces disagree on. Split out so the
 * incremental converter in `./inbound-stream.ts`, which never assembles
 * a `ChatCompletionResponse` to read it off, maps usage identically.
 */
export function convertChatUsageToResponses(usage: Record<string, unknown>): Record<string, number> {
  const count = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return {
    input_tokens: count(usage.prompt_tokens),
    output_tokens: count(usage.completion_tokens),
    total_tokens: count(usage.total_tokens)
  }
}

export function convertChatCompletionToResponses(chat: ChatCompletionResponse): Record<string, unknown> {
  const firstChoice = chat.choices?.[0]
  const output = buildResponsesOutputItems(firstChoice?.message)
  const usage = chat.usage ? convertChatUsageToResponses({ ...chat.usage }) : undefined
  const envelope: Record<string, unknown> = {
    id: chat.id ?? `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response',
    created_at: chat.created ?? nowSeconds(),
    status: 'completed',
    model: chat.model ?? '',
    output
  }
  if (usage !== undefined) envelope.usage = usage
  return envelope
}

// ─── SSE: wrap a Responses envelope as a minimal Responses SSE stream ──

/**
 * Emit the fully-assembled Responses envelope as a short SSE sequence:
 *
 *   response.created         (skeleton)
 *   response.in_progress     (skeleton)
 *   response.output_item.added / *.done for each output item
 *   response.output_text.delta / *.done for the message text (if any)
 *   response.completed       (full envelope)
 *
 * Buffered by construction: it needs the finished envelope. The live
 * path is `convertChatSseToResponsesSse` in `./inbound-stream.ts`, which
 * emits this same vocabulary as the upstream produces it; this remains
 * for the case where there is no body left to read incrementally, and
 * for callers that already hold a complete envelope.
 */
export function wrapResponsesEnvelopeAsSse(envelope: Record<string, unknown>): string {
  const lines: string[] = []
  const skeleton = { ...envelope, output: [] }
  lines.push(sseEvent('response.created', { type: 'response.created', response: skeleton }))
  lines.push(sseEvent('response.in_progress', { type: 'response.in_progress', response: skeleton }))
  const outputs = Array.isArray(envelope.output) ? envelope.output : []
  for (let i = 0; i < outputs.length; i++) {
    const item = outputs[i]
    if (!isObject(item)) continue
    lines.push(
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: i,
        item
      })
    )
    if (item.type === 'message') {
      const contentBlocks = Array.isArray(item.content) ? item.content : []
      for (let ci = 0; ci < contentBlocks.length; ci++) {
        const block = contentBlocks[ci]
        if (!isObject(block) || block.type !== 'output_text' || typeof block.text !== 'string') continue
        lines.push(
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: i,
            content_index: ci,
            delta: block.text
          })
        )
        lines.push(
          sseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: i,
            content_index: ci,
            text: block.text
          })
        )
      }
    } else if (item.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : ''
      lines.push(
        sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: i,
          delta: args
        })
      )
      lines.push(
        sseEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: item.id,
          output_index: i,
          arguments: args
        })
      )
    } else if (item.type === 'custom_tool_call') {
      // The custom kind has its own pair of events, and the Codex CLI
      // reads the call's text off them rather than off the item — a
      // function_call_arguments pair here would leave it with an empty
      // command to run.
      const callInput = typeof item.input === 'string' ? item.input : ''
      lines.push(
        sseEvent('response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          item_id: item.id,
          output_index: i,
          delta: callInput
        })
      )
      lines.push(
        sseEvent('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          item_id: item.id,
          output_index: i,
          input: callInput
        })
      )
    }
    lines.push(
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: i,
        item
      })
    )
  }
  lines.push(sseEvent('response.completed', { type: 'response.completed', response: envelope }))
  return lines.join('')
}

function sseEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

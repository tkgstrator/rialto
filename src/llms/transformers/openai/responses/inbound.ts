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
 * Kept minimal: text, tools (top-level, or in the Lite shape's
 * `additional_tools` input item), both tool-call kinds (function_call /
 * custom_tool_call, with their namespace, and their outputs), and input
 * images are supported. Uncommon shapes (audio, refusal, custom
 * annotations) round-trip through the pipeline verbatim rather than
 * throwing, so the upstream error surfaces to the caller instead of a
 * schema violation here.
 */

import { randomUUID } from 'node:crypto'
import type { UnifiedChatRequest } from '@/schemas/domain/unified'
import {
  type ChatCompletionResponse,
  type ChatCompletionResponseMessage,
  type ChatCompletionResponseToolCall,
  ResponsesInboundAdditionalToolsItemSchema,
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
import {
  customInputOf,
  NO_TOOL_LOWERING,
  raisedCallOf,
  type ToolLowering,
  toolLoweringOf
} from '../../../utils/tool-lowering'
import { firstDefined, namespaceOf } from './helpers'

// ─── Request: Responses → UnifiedChatRequest ───────────────────────────

const TEXT_PART_TYPES: ReadonlySet<unknown> = new Set(['input_text', 'output_text', 'text'])

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
    if (TEXT_PART_TYPES.has(item.type) && typeof item.text === 'string') {
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

type CallItem = { call_id?: string; id?: string; name?: string; namespace?: string | null }

// An assistant turn that called a tool, in the one shape chat-completions
// has for both kinds. `payload` is the call's arguments (JSON, for the
// function kind) or its input (free text, for the custom kind); `kind` is
// what lets the outbound side put it back under the right name, and
// `namespace` under the right namespace tool (UnifiedToolCallSchema).
function toolCallMessage(item: CallItem, kind: 'function' | 'custom', payload: string | undefined) {
  const known = firstDefined([item.call_id, item.id])
  const call = {
    id: known === undefined ? `call_${randomUUID().slice(0, 8)}` : known,
    type: kind,
    ...namespaceOf(item.namespace),
    function: {
      name: typeof item.name === 'string' ? item.name : '',
      arguments: typeof payload === 'string' ? payload : ''
    }
  }
  return { role: 'assistant', content: null, tool_calls: [call] }
}

// `data:image/png;base64,…` names its own media type, which Gemini's
// `inlineData` needs to rebuild the image from its bytes. A plain URL does
// not, and its part goes without one, as an image on a message does.
function withMediaType(part: { type: 'image_url'; image_url: { url: string } }): Record<string, unknown> {
  const declared = /^data:([^;,]+)[;,]/.exec(part.image_url.url)
  return declared === null ? part : { ...part, media_type: declared[1] }
}

// One part of an array tool output, as unified content parts.
function toolOutputParts(part: unknown): Array<Record<string, unknown>> {
  if (typeof part === 'string') return part.length > 0 ? [{ type: 'text', text: part }] : []
  if (isObject(part) && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') {
    return part.text.length > 0 ? [{ type: 'text', text: part.text }] : []
  }
  const images = contentImageParts([part])
  if (images.length > 0) return images.map(withMediaType)
  // `input_file` and anything newer: unified has no part for it, so it
  // keeps the JSON the whole output used to be sent as.
  return [{ type: 'text', text: JSON.stringify(part) }]
}

/**
 * A tool's output, as the unified tool message carries it.
 *
 * An array is content parts — the Codex CLI answers its code-mode `exec`
 * with `[{type:'input_text', text}, …]` — and stays parts, so each outbound
 * conversion renders them in its own wire format: Responses as the same
 * `input_text` / `input_image` output array (request.ts), Chat and Gemini,
 * whose tool role takes no image, through `liftToolResultImages`. It used to be
 * `JSON.stringify`'d, so the model read its tool's result as a JSON dump of
 * part objects, and re-read it in every later turn. Any other non-string
 * keeps that JSON, which is all there is to send for it.
 */
function toolResultContent(output: unknown): string | Array<Record<string, unknown>> {
  if (typeof output === 'string') return output
  if (output === undefined) return ''
  if (!Array.isArray(output)) return JSON.stringify(output)
  const parts = output.flatMap(toolOutputParts)
  return parts.length > 0 ? parts : ''
}

// The result of having run one, likewise. `tool_call_type` rides along
// only for the custom kind so that a function result stays byte-identical
// to what every caller before custom tools produced.
function toolResultMessage(callId: string | undefined, kind: 'function' | 'custom', output: unknown) {
  const message: Record<string, unknown> = {
    role: 'tool',
    tool_call_id: typeof callId === 'string' ? callId : '',
    content: toolResultContent(output)
  }
  if (kind === 'custom') message.tool_call_type = kind
  return message
}

function convertToolResponsesToChat(raw: unknown): unknown[] {
  if (!isObject(raw)) return []
  if (raw.type === 'web_search') {
    // The Chat wire form of a hosted web-search tool is a function
    // whose name is literally "web_search"; remapTools on the other
    // side collapses it back to `{type:'web_search'}`.
    return [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Hosted web search',
          parameters: { type: 'object', properties: {} }
        }
      }
    ]
  }
  if (raw.type !== 'function') {
    // A tool with no Chat-Completions equivalent — Codex's `namespace`,
    // `custom` and `local_shell`. Carry it verbatim: the unified type has a
    // member for exactly this (UnifiedPassthroughTool), so each
    // outbound transformer decides what its own upstream can do with
    // it rather than us dropping it here.
    return [raw]
  }
  if (typeof raw.name !== 'string') return []
  const parameters = isObject(raw.parameters) ? raw.parameters : { type: 'object', properties: {} }
  const fn: Record<string, unknown> = { name: raw.name, parameters }
  if (typeof raw.description === 'string') fn.description = raw.description
  return [{ type: 'function', function: fn }]
}

// What a tool is called: its name (under `function` once converted), or
// its type for the nameless hosted tools (`web_search`, `local_shell`).
function toolName(tool: unknown): string {
  if (!isObject(tool)) return ''
  const fn = tool.function
  if (isObject(fn) && typeof fn.name === 'string') return fn.name
  if (typeof tool.name === 'string') return tool.name
  return typeof tool.type === 'string' ? `type:${tool.type}` : ''
}

/**
 * One tool per name. Two declarations under one name — a tool, or a
 * namespace — leave the upstream to pick between them or to refuse the
 * request, so one is kept: the later. The top-level `tools` are read first,
 * as the base, and then the input, which is history read in order, so a
 * name declared again further down is the newer declaration. It takes the
 * earlier one's place in the list rather than moving to the end: the tool
 * list is part of the prompt prefix the upstream caches (and of
 * codex-oauth's `prompt_cache_key`), and a redefinition should not reorder
 * it.
 */
function oneToolPerName(tools: unknown[]): unknown[] {
  const byName = new Map<string, unknown>()
  for (const tool of tools) byName.set(toolName(tool), tool)
  return [...byName.values()]
}

function additionalToolsOf(item: unknown): unknown[] {
  const parsed = ResponsesInboundAdditionalToolsItemSchema.safeParse(item)
  return parsed.success ? parsed.data.tools : []
}

/**
 * Every tool the request declares, in unified form. The Lite shape (see
 * ResponsesInboundAdditionalToolsItemSchema) declares them in an input item
 * instead of at the top level, and that item used to be skipped as an
 * unknown one — so the upstream was sent no tools at all, and the model
 * could not run a command. Its tools are read exactly as top-level ones.
 *
 * Undefined when the request declares neither, so a request without tools
 * still carries no `tools` key: an empty list would be sent upstream as one.
 */
function declaredTools(body: Record<string, unknown>): unknown[] | undefined {
  const added = Array.isArray(body.input) ? body.input.flatMap(additionalToolsOf) : []
  if (!Array.isArray(body.tools) && added.length === 0) return undefined
  const topLevel: unknown[] = Array.isArray(body.tools) ? body.tools : []
  return oneToolPerName([...topLevel, ...added].flatMap(convertToolResponsesToChat))
}

/**
 * How a function-only upstream was sent this caller's tools
 * (`tool-lowering.ts`), worked out again from the caller's own Responses
 * body — the only thing the response side has. It runs the same
 * `declaredTools` the request side did, so it arrives at the same names.
 * A body that is not a Responses request declares nothing, and nothing is
 * raised.
 */
export function callerToolLowering(body: unknown): ToolLowering {
  return isObject(body) ? toolLoweringOf(declaredTools(body)) : NO_TOOL_LOWERING
}

// One input item, as the unified messages it stands for. An item with no
// counterpart yields none — `additional_tools` among them, whose tools
// `declaredTools` reads — and a request made only of such items reaches the
// pipeline as "no messages" rather than as a schema violation here.
function inputItemMessages(raw: unknown): Array<Record<string, unknown>> {
  const fc = ResponsesInboundFunctionCallItemSchema.safeParse(raw)
  if (fc.success) return [toolCallMessage(fc.data, 'function', fc.data.arguments)]
  const fco = ResponsesInboundFunctionCallOutputItemSchema.safeParse(raw)
  if (fco.success) return [toolResultMessage(fco.data.call_id, 'function', fco.data.output)]
  const ctc = ResponsesInboundCustomToolCallItemSchema.safeParse(raw)
  if (ctc.success) return [toolCallMessage(ctc.data, 'custom', ctc.data.input)]
  const ctco = ResponsesInboundCustomToolCallOutputItemSchema.safeParse(raw)
  if (ctco.success) return [toolResultMessage(ctco.data.call_id, 'custom', ctco.data.output)]
  const msgItem = ResponsesInboundMessageItemSchema.safeParse(raw)
  const msg = msgItem.success ? convertMessageItem(msgItem.data) : null
  return msg === null ? [] : [msg]
}

function inputMessages(input: unknown): Array<Record<string, unknown>> {
  if (typeof input === 'string') return input.length > 0 ? [{ role: 'user', content: input }] : []
  if (!Array.isArray(input)) return []
  return input.flatMap((raw) => (isObject(raw) ? inputItemMessages(raw) : []))
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

  messages.push(...inputMessages(body.input))

  // Absorb an Anthropic-style top-level `system` (Responses API doesn't
  // model it, but a persona-enriched pipeline could still leave one) as
  // a leading system message. Matches OpenAITransformer.transformRequestOut.
  const systemText = body.system !== undefined && body.system !== null ? flattenSystemToText(body.system) : ''
  if (systemText.length > 0 && (messages.length === 0 || messages[0]?.role !== 'system')) {
    messages.unshift({ role: 'system', content: systemText })
  }

  const tools = declaredTools(body)
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

function toolCallOutputItem(tc: ChatCompletionResponseToolCall, lowering: ToolLowering): Record<string, unknown> {
  const known = firstDefined([tc.id])
  const callId = known === undefined ? `call_${randomUUID().slice(0, 8)}` : known
  const wireName = typeof tc.function?.name === 'string' ? tc.function.name : ''
  const wirePayload = typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''
  // A call a function-only upstream made into a lowered tool goes back as
  // the caller declared it: its own name and namespace, and for a custom
  // tool the text out of the `{"input": …}` arguments.
  const raised = raisedCallOf(lowering, { type: tc.type, namespace: tc.namespace, name: wireName })
  const name = raised === null ? wireName : raised.name
  const payload = raised?.kind === 'custom' ? customInputOf(wirePayload) : wirePayload
  // A call into a namespace tool says which one. The Codex CLI dispatches
  // on namespace and name together, so `exec` without `functions` is a
  // tool it does not have, and it replays the item as handed — namespace
  // included — on the next turn.
  const namespace = namespaceOf(raised === null ? tc.namespace : raised.namespace)
  // A custom tool's call is a different output item, not a
  // `function_call` with a different payload: the Codex CLI reads
  // `input`, and the upstream expects the matching
  // `custom_tool_call_output` on the next turn.
  if ((raised === null ? tc.type : raised.kind) === 'custom') {
    return {
      id: `ctc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: callId,
      name,
      ...namespace,
      input: payload
    }
  }
  return {
    id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    ...namespace,
    arguments: payload
  }
}

function buildResponsesOutputItems(
  message: ChatCompletionResponseMessage | undefined,
  lowering: ToolLowering
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  const content = message?.content
  const text = typeof content === 'string' ? content : contentTextParts(content)
  if (text.length > 0) {
    items.push({
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: typeof message?.role === 'string' ? message.role : 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  if (Array.isArray(message?.tool_calls))
    items.push(...message.tool_calls.map((tc) => toolCallOutputItem(tc, lowering)))
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

/**
 * A chat completion as the Responses envelope. `lowering` is how the
 * caller's tools were sent to a function-only upstream
 * (`callerToolLowering`), so its calls can be handed back as declared;
 * without one, every call goes back exactly as the upstream made it.
 */
export function convertChatCompletionToResponses(
  chat: ChatCompletionResponse,
  lowering: ToolLowering = NO_TOOL_LOWERING
): Record<string, unknown> {
  const firstChoice = chat.choices?.[0]
  const output = buildResponsesOutputItems(firstChoice?.message, lowering)
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

export { wrapResponsesEnvelopeAsSse } from './inbound-envelope-sse'

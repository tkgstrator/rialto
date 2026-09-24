/**
 * The routing signals a request carries, read out of whichever wire
 * format it arrived in.
 *
 * The tier map gates each route on two questions about a request: will
 * the prompt fit in the route's context window, and did the caller attach
 * a web-search tool the route may not be able to run. Both have to be
 * answered in the vocabulary the request arrived in — a Responses caller
 * carries its turns in `input`, a Gemini caller in `contents[]`, and each
 * vendor spells its search tool differently. Read only under Anthropic's
 * names, a Responses or Gemini prompt would weigh nothing, no other
 * vendor's search tool would be seen, and both gates would wave those
 * requests through.
 *
 * Extraction lives per surface for the same reason the rest of the
 * inbound knowledge does (`src/llms/inbound/surfaces.ts`): adding a
 * fifth surface should mean adding one entry here, not hunting for
 * every place a vocabulary leaked into the router.
 *
 * The set is deliberately small: what those two gates read, and nothing
 * else. Anything the router does not branch on has no business being
 * normalised here.
 */

import { surfaceForPath } from '@/llms/inbound/surfaces'
import { readGeminiSignals } from '@/llms/utils/gemini/router-signals'
import type { TokenizeContentBlock, TokenizeMessage, TokenizeRequest, TokenizeTool } from '@/schemas/domain/tokenizer'
import { isObject } from '../utils/guards'
import { isThinkingEnabled, isWebSearchTool } from './request-signals'
import type { RouterRequestBody } from './types'

export type RouterSignals = {
  /**
   * What to hand the tokenizer. The count is weighed against each
   * route's context window, and `/v1/messages/count_tokens` reports the
   * same number, so a client and the router cannot disagree on a size.
   */
  tokenize: TokenizeRequest
  /**
   * Did the caller opt into extended thinking / reasoning? It picks the
   * Think scenario. Read per surface: Anthropic has `thinking`, OpenAI
   * its reasoning controls, Gemini `thinkingConfig`.
   */
  thinking: boolean
  /**
   * Did the caller attach that surface's web-search tool? A route whose
   * model cannot run it is skipped rather than sent the request without
   * its tool. Read per surface because every vendor spells it differently.
   */
  webSearch: boolean
}

type SignalReader = (body: RouterRequestBody) => RouterSignals

const readAnthropicSignals: SignalReader = (body) => ({
  tokenize: {
    messages: Array.isArray(body.messages) ? body.messages : [],
    system: body.system,
    tools: body.tools
  },
  thinking: isThinkingEnabled(body),
  webSearch: Array.isArray(body.tools) && body.tools.some(isWebSearchTool)
})

// ─── OpenAI: /v1/chat/completions and /v1/responses ────────────────────
//
// Both surfaces speak one vendor vocabulary and differ only in where
// they put things, so `webSearch`, which does not move, is read by one
// helper and only `tokenize` gets a reader per surface.
//
// These run on the RAW inbound body. The endpoint transformers that
// normalise these shapes (`convertResponsesRequestToUnified` turns
// `input` into `messages`) run in the pipeline, which is AFTER
// `buildRoutePlan` has already routed. Reading the normalised shape here
// is therefore not an option — it does not exist yet.

/** A tool's declared name, from either the nested or the flat shape. */
function openAiToolName(tool: Record<string, unknown>): string | undefined {
  const nested = isObject(tool.function) ? tool.function.name : undefined
  if (typeof nested === 'string' && nested.length > 0) return nested
  return typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : undefined
}

/**
 * Whether the caller attached OpenAI's hosted web search.
 *
 * Three spellings arrive, all meaning the same thing:
 *   - `{type: 'web_search'}` / `{type: 'web_search_preview'}` — the
 *     hosted tool as Responses declares it. Prefix-matched because
 *     OpenAI versions the type (`web_search_2025_08_26`), the same
 *     reason `isWebSearchTool` prefix-matches Anthropic's.
 *   - a function literally named `web_search` — the Chat wire form, and
 *     the form Rialto's own Responses→Chat converter emits
 *     (`transformers/openai/responses/inbound.ts`), so both sides of the
 *     conversion agree on one spelling.
 *   - top-level `web_search_options` — how Chat Completions enables
 *     search on the `*-search-preview` models, which declare no tool
 *     entry at all.
 */
function openAiWebSearch(body: RouterRequestBody): boolean {
  if (isObject(body.web_search_options)) return true
  // Widened deliberately: `RouterRequestBody.tools` is declared as
  // `TokenizeTool[]`, which is the Anthropic-ish shape, and an OpenAI
  // tool entry has none of its fields.
  const tools: unknown = body.tools
  if (!Array.isArray(tools)) return false
  return tools.some((tool) => {
    if (!isObject(tool)) return false
    if (typeof tool.type === 'string' && tool.type.startsWith('web_search')) return true
    const name = openAiToolName(tool)
    if (name === undefined) return false
    return name.startsWith('web_search')
  })
}

const textBlock = (text: string): TokenizeContentBlock => ({ type: 'text', text })

/**
 * A tool call's arguments as a `tool_use` block.
 *
 * OpenAI carries arguments as a JSON *string* on both surfaces while
 * Anthropic sends the decoded object, and the tokenizer re-serialises
 * whatever `input` holds. Handing it the raw string would make it escape
 * every quote and count an inflated payload, so decode first — and fall
 * back to the string itself when it is not valid JSON, which is what a
 * truncated or hand-rolled call looks like.
 */
function toolUseBlock(args: string): TokenizeContentBlock {
  return { type: 'tool_use', input: decodeToolArguments(args) }
}

function decodeToolArguments(args: string): unknown {
  try {
    const parsed: unknown = JSON.parse(args)
    return parsed
  } catch {
    return args
  }
}

/** Text parts of a content value, in either surface's block spelling. */
function openAiTextBlocks(content: unknown): TokenizeContentBlock[] {
  if (typeof content === 'string') return [textBlock(content)]
  if (!Array.isArray(content)) return []
  // `input_text` / `output_text` (Responses) and `text` (Chat) all put
  // the prose on `.text`, so the discriminator does not need reading.
  // Image parts carry a URL rather than prose and are skipped, matching
  // how the Anthropic reader treats its own image blocks.
  return content.flatMap((part) => (isObject(part) && typeof part.text === 'string' ? [textBlock(part.text)] : []))
}

/**
 * Tool declarations in the shape the tokenizer counts.
 *
 * Chat nests the schema under `function`, Responses puts it flat, and
 * both call the JSON schema `parameters` where `TokenizeTool` calls it
 * `input_schema`. Without this remap an OpenAI caller's tools count as
 * zero tokens — none of `TokenizeTool`'s three fields is where it looks
 * — and a large tool manifest is exactly what pushes an agentic
 * conversation past a route's context window. Hosted tools have no
 * schema to weigh and drop out here; the one the router cares about,
 * web search, is read separately by `openAiWebSearch`.
 */
function openAiTokenizeTools(tools: unknown): TokenizeTool[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!isObject(tool)) return []
    const decl = isObject(tool.function) ? tool.function : tool
    const name = openAiToolName(tool)
    if (name === undefined) return []
    const description = typeof decl.description === 'string' ? decl.description : undefined
    const input_schema = isObject(decl.parameters) ? decl.parameters : {}
    return [description === undefined ? { name, input_schema } : { name, description, input_schema }]
  })
}

/**
 * Chat turns, in the shape the tokenizer counts.
 *
 * `role` / `content` already line up with `TokenizeMessage`, but an
 * assistant turn that calls a tool puts the arguments in `tool_calls[]`
 * and usually leaves `content` null — Anthropic puts the same payload in
 * a `tool_use` content block, which the tokenizer DOES count. Left
 * as-is, every tool call in an agentic conversation weighs zero and a
 * Chat caller's conversation never looks too big for any route's context
 * window: the same class of undercount as `input` counting zero on
 * Responses.
 */
function openAiChatMessages(messages: unknown): TokenizeMessage[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) => {
    if (!isObject(message)) return []
    const role = typeof message.role === 'string' && message.role.length > 0 ? message.role : 'user'
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const content = [
      ...openAiTextBlocks(message.content),
      ...calls.flatMap((call) => {
        if (!isObject(call)) return []
        const fn = isObject(call.function) ? call.function : call
        return typeof fn.arguments === 'string' ? [toolUseBlock(fn.arguments)] : []
      })
    ]
    return [{ role, content }]
  })
}

/**
 * Responses turns, in the shape the tokenizer counts.
 *
 * `input` is either a single user string or the item list. The item
 * kinds are the ones `convertResponsesRequestToUnified` accepts, but the
 * target here is `TokenizeMessage`, so a `function_call`'s arguments and
 * a `function_call_output`'s result become the two content blocks the
 * tokenizer knows how to weigh rather than chat's `tool_calls` /
 * `role:'tool'` shapes.
 *
 * `reasoning` items — which Codex CLI echoes back with an
 * `encrypted_content` blob — are skipped: the blob is opaque base64, and
 * counting it with a text encoding would overstate the conversation by
 * far more than omitting it understates it.
 */
function openAiResponsesMessages(input: unknown): TokenizeMessage[] {
  if (typeof input === 'string') return input.length === 0 ? [] : [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => (isObject(item) ? responsesInputItem(item) : []))
}

function responsesInputItem(item: Record<string, unknown>): TokenizeMessage[] {
  if (item.type === 'function_call') {
    const args = item.arguments
    return typeof args === 'string' ? [{ role: 'assistant', content: [toolUseBlock(args)] }] : []
  }
  if (item.type === 'function_call_output') {
    // The tokenizer already handles a `tool_result` whose content is
    // either a string or a structure, so `output` passes through as-is.
    return [{ role: 'tool', content: [{ type: 'tool_result', content: item.output }] }]
  }
  if (item.type !== undefined && item.type !== 'message') return []
  const role = typeof item.role === 'string' && item.role.length > 0 ? item.role : 'user'
  return [{ role, content: openAiTextBlocks(item.content) }]
}

/**
 * Whether an OpenAI-shaped caller asked the model to reason — the Think
 * scenario.
 *
 * OpenAI has no `thinking` field, so the opt-in is read off the reasoning
 * controls, mirroring the Anthropic rule: presence of a control is the
 * opt-in and `'none'` — OpenAI's own "do not reason" — the opt-out. Chat
 * Completions names it `reasoning_effort` at the top level, Responses
 * nests it as `reasoning.effort`; both spellings are read on both
 * surfaces, since clients send whichever their SDK version emits. A
 * `reasoning` object carrying no effort still counts: Codex CLI sends
 * `reasoning: {summary: 'auto'}`, and asking for a reasoning summary is
 * asking for reasoning. Absence is not an opt-in even though both vendors
 * reason server-side by default: Think grades the client's intent.
 */
function openAiReasoningRequested(body: RouterRequestBody): boolean {
  const flat = body.reasoning_effort
  if (typeof flat === 'string' && flat.length > 0) return flat !== 'none'
  const reasoning = body.reasoning
  if (!isObject(reasoning)) return false
  const nested = reasoning.effort
  if (typeof nested === 'string' && nested.length > 0) return nested !== 'none'
  return true
}

const readOpenAiChatSignals: SignalReader = (body) => ({
  // No `system`: Chat carries the system prompt as `messages[0]`, and
  // the surface never receives a top-level one — persona injection is
  // gated to /v1/messages precisely because OpenAI upstreams 400 on it.
  tokenize: {
    messages: openAiChatMessages(body.messages),
    tools: openAiTokenizeTools(body.tools)
  },
  thinking: openAiReasoningRequested(body),
  webSearch: openAiWebSearch(body)
})

const readOpenAiResponsesSignals: SignalReader = (body) => ({
  tokenize: {
    messages: openAiResponsesMessages(body.input),
    // Responses' top-level system prompt. `TokenizeRequest.system`
    // accepts a bare string, so no block wrapping is needed.
    system: typeof body.instructions === 'string' ? body.instructions : undefined,
    tools: openAiTokenizeTools(body.tools)
  },
  thinking: openAiReasoningRequested(body),
  webSearch: openAiWebSearch(body)
})

/**
 * Per-surface readers. A surface with no entry falls back to the
 * Anthropic reader, which is what every caller got before this module
 * existed — an unknown surface therefore behaves exactly as it did,
 * rather than losing signals it was previously (accidentally) matching.
 */
const READERS: Partial<Record<string, SignalReader>> = {
  'anthropic-messages': readAnthropicSignals,
  'openai-chat': readOpenAiChatSignals,
  'openai-responses': readOpenAiResponsesSignals,
  'gemini-generate': readGeminiSignals
}

/**
 * Read the routing signals for a request that arrived on `inboundPath`.
 *
 * `inboundPath` is optional on `RouterRequest` for test callers that
 * predate the surface registry; those resolve to the Anthropic reader,
 * preserving the behaviour they were written against.
 */
export function readSignals(body: RouterRequestBody, inboundPath: string | undefined): RouterSignals {
  const surface = surfaceForPath(inboundPath)
  const reader = surface === undefined ? undefined : READERS[surface.id]
  return (reader === undefined ? readAnthropicSignals : reader)(body)
}

/**
 * Signals for a request, computed once and cached on it.
 *
 * Cached because a gemini `contents[]` walk is not free, and the body
 * does not change while the request is being routed. Stored on the
 * request rather than threaded through because that is how the router
 * already carries derived state (`tokenCount`, `route`).
 */
export function signalsOf(req: {
  body: RouterRequestBody
  inboundPath?: string
  signals?: RouterSignals
}): RouterSignals {
  if (req.signals !== undefined) return req.signals
  const computed = readSignals(req.body, req.inboundPath)
  req.signals = computed
  return computed
}

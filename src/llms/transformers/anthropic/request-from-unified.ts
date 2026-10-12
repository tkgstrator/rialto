/**
 * Unified (Chat-shaped) request → Anthropic Messages request.
 *
 * The outbound conversion both Claude steps run on the conversion path —
 * `anthropic` (API key) and `claude-code-oauth` (subscription) — for a
 * caller on /v1/chat/completions, /v1/responses or the Gemini surface whose
 * request was routed to Claude. `/v1/messages` → Claude never reaches it:
 * that is the bypass path, and the body goes upstream as the client wrote
 * it. The reverse of `request.ts`, which turns an Anthropic request into
 * unified for every other vendor.
 *
 * Built field by field rather than edited in place, so nothing a caller's
 * own wire format carries — `stream_options`, `parallel_tool_calls`,
 * `store`, `include`, `prompt_cache_key`, `text`, `user`, … — reaches an
 * upstream that rejects unknown top-level fields.
 *
 * The parts that need explaining:
 *
 *   - Tools first go through `lowerResponsesTools`, so a Responses caller's
 *     namespace and custom tools arrive as functions (see that module).
 *   - System and developer messages, wherever they sit, are hoisted into
 *     the top-level `system`: Anthropic refuses a `system` role in
 *     `messages`, and a mid-conversation system message is accepted only by
 *     some models.
 *   - A run of `role:'tool'` messages becomes one user turn of
 *     `tool_result` blocks, results first: Anthropic wants every result for
 *     an assistant turn in the single user turn after it, ahead of any
 *     text, and a client that splits parallel results over several turns
 *     teaches the model to stop calling in parallel.
 *   - Cache breakpoints go on the tool list, the system prompt and the
 *     last block of the conversation (`addCacheBreakpoints`): an OpenAI
 *     caller cannot place any, and Anthropic caches nothing without them.
 *   - Thinking. An OpenAI-family caller never hands Anthropic thinking
 *     blocks back — its wire format has nowhere to keep them — so a
 *     continued tool loop arrives without them. That is accepted when the
 *     model thinks adaptively, which is what it does with `thinking` left
 *     out (its default on Opus 5 and later, Sonnet 5.5 and Fable), and when
 *     it does not think at all. Manual thinking (`budget_tokens`) is the one
 *     mode that requires the last assistant turn of a tool loop to start
 *     with a thinking block, so a caller who sent one anyway has it left out
 *     of a turn that continues a tool loop rather than send a request that
 *     is certain to be a 400. Nothing here turns thinking on: the caller's
 *     effort becomes `output_config.effort`, and the model decides.
 */

import type { RuntimeProvider, TransformerContext } from '@/schemas/domain/pipeline'
import {
  isUnifiedFunctionTool,
  type UnifiedChatRequest,
  type UnifiedFunctionTool,
  type UnifiedMessage,
  type UnifiedToolCall
} from '@/schemas/domain/unified'
import { isObject } from '../../utils/guards'
import { lowerResponsesTools } from '../../utils/tool-lowering'
import { acceptsForcedToolChoice, acceptsSamplingParams, DEFAULT_MAX_TOKENS } from './model-rules'

type Block = Record<string, unknown>
type Turn = { readonly role: 'user' | 'assistant'; readonly content: Block[] }

// ─── Content ───────────────────────────────────────────────────────────

const TEXT_PART_TYPES: ReadonlySet<unknown> = new Set(['text', 'input_text', 'output_text'])
const IMAGE_PART_TYPES: ReadonlySet<unknown> = new Set(['image_url', 'input_image'])
const SYSTEM_ROLES: ReadonlySet<string> = new Set(['system', 'developer'])

function cacheControlOf(value: unknown): Block {
  return isObject(value) && typeof value.type === 'string' ? { cache_control: { type: value.type } } : {}
}

// Anthropic refuses an empty or whitespace-only text block.
function textBlocks(text: string, cacheControl?: unknown): Block[] {
  return text.trim().length > 0 ? [{ type: 'text', text, ...cacheControlOf(cacheControl) }] : []
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

// An image part as an Anthropic image block: a data URL's bytes as a
// base64 source, a web URL as a url source. Anything else (a file id, a
// local path) is nothing Anthropic can fetch, and is left out.
function imageBlocks(part: Record<string, unknown>): Block[] {
  const raw = part.image_url
  const url = typeof raw === 'string' ? raw : isObject(raw) && typeof raw.url === 'string' ? raw.url : ''
  const inline = DATA_URL.exec(url)
  if (inline !== null) return [{ type: 'image', source: { type: 'base64', media_type: inline[1], data: inline[2] } }]
  if (/^https?:\/\//i.test(url)) return [{ type: 'image', source: { type: 'url', url } }]
  return []
}

function partBlocks(part: unknown, withImages: boolean): Block[] {
  if (typeof part === 'string') return textBlocks(part)
  if (!isObject(part)) return []
  if (TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') return textBlocks(part.text, part.cache_control)
  if (withImages && IMAGE_PART_TYPES.has(part.type)) return imageBlocks(part)
  return []
}

function contentBlocks(content: unknown, withImages: boolean): Block[] {
  if (typeof content === 'string') return textBlocks(content)
  return Array.isArray(content) ? content.flatMap((part) => partBlocks(part, withImages)) : []
}

function plainText(content: unknown): string {
  return contentBlocks(content, false)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n\n')
}

// ─── System ────────────────────────────────────────────────────────────

// A top-level `system` some earlier step left on the unified body, kept
// ahead of the hoisted messages as the subscription step always kept it.
function carriedSystem(system: unknown): Block[] {
  if (typeof system === 'string') return textBlocks(system)
  if (!Array.isArray(system)) return []
  return system.flatMap((block) =>
    isObject(block) && typeof block.text === 'string' ? textBlocks(block.text, block.cache_control) : []
  )
}

// One block per system message, in order: a client may send several (one
// per stable prefix), and dropping the later ones would lose instructions.
function systemBlocks(request: Record<string, unknown>, messages: readonly UnifiedMessage[]): Block[] {
  const hoisted = messages
    .filter((message) => SYSTEM_ROLES.has(message.role))
    .flatMap((message) => textBlocks(plainText(message.content), message.cache_control))
  return [...carriedSystem(request.system), ...hoisted]
}

// ─── Messages ──────────────────────────────────────────────────────────

// Anthropic ids are `^[a-zA-Z0-9_-]+$`. A call id and the id its result
// answers go through the same function, so they still pair.
const wireId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')

// Anthropic takes a tool's input as an object. Arguments that are empty,
// or never parsed to one, are a call no tool could have run with them
// either, so the history keeps the call and drops what cannot be read.
function toolInput(args: string): Record<string, unknown> {
  if (args.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(args)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function toolUseBlock(call: UnifiedToolCall): Block {
  return { type: 'tool_use', id: wireId(call.id), name: call.function.name, input: toolInput(call.function.arguments) }
}

function toolResultBlock(message: UnifiedMessage): Block {
  const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  const block: Block = { type: 'tool_result', tool_use_id: wireId(id), ...cacheControlOf(message.cache_control) }
  // A string result stays a string. Content parts — the Codex CLI answers
  // its `exec` with several — stay parts, images included: a tool_result
  // takes both, so nothing is lifted out as on the Chat path.
  if (typeof message.content === 'string' && message.content.length > 0) return { ...block, content: message.content }
  const parts = contentBlocks(message.content, true)
  return parts.length > 0 ? { ...block, content: parts } : block
}

function turnOf(message: UnifiedMessage): Turn | null {
  if (SYSTEM_ROLES.has(message.role)) return null
  if (message.role === 'tool') return { role: 'user', content: [toolResultBlock(message)] }
  if (message.role === 'assistant') {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const content = [...contentBlocks(message.content, false), ...calls.map(toolUseBlock)]
    return content.length > 0 ? { role: 'assistant', content } : null
  }
  const content = contentBlocks(message.content, true)
  return content.length > 0 ? { role: 'user', content } : null
}

function resultsFirst(turn: Turn): Turn {
  if (turn.role !== 'user') return turn
  const results = turn.content.filter((block) => block.type === 'tool_result')
  if (results.length === 0) return turn
  return { role: 'user', content: [...results, ...turn.content.filter((block) => block.type !== 'tool_result')] }
}

// Consecutive same-role messages make one turn. Unified gives each call
// and each result its own message (a Responses caller's parallel calls
// arrive as several assistant messages); Anthropic pairs a turn's
// `tool_use` blocks with the `tool_result` blocks of the one turn after it.
function turnsOf(messages: readonly UnifiedMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    const turn = turnOf(message)
    if (turn === null) continue
    const last = turns.at(-1)
    if (last !== undefined && last.role === turn.role) last.content.push(...turn.content)
    else turns.push({ role: turn.role, content: [...turn.content] })
  }
  return turns.map(resultsFirst)
}

// ─── Tools ─────────────────────────────────────────────────────────────

// The hosted web search, in the one shape every inbound converter gives
// it: a function named `web_search` with nothing to fill in. Anthropic
// runs its own as a server tool, so it goes as that instead of a function
// the client would be asked to execute.
function isHostedWebSearch(tool: UnifiedFunctionTool): boolean {
  if (tool.function.name !== 'web_search') return false
  const properties: unknown = tool.function.parameters?.properties
  return !isObject(properties) || Object.keys(properties).length === 0
}

function inputSchemaOf(parameters: unknown): Block {
  return isObject(parameters) ? { ...parameters, type: 'object' } : { type: 'object', properties: {} }
}

function toolDefinition(tool: UnifiedFunctionTool): Block {
  if (isHostedWebSearch(tool)) return { type: 'web_search_20250305', name: 'web_search' }
  const description: unknown = tool.function.description
  return {
    name: tool.function.name,
    ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
    input_schema: inputSchemaOf(tool.function.parameters),
    ...cacheControlOf(tool.cache_control)
  }
}

function baseToolChoice(choice: UnifiedChatRequest['tool_choice']): Block | undefined {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === 'string') {
    return { type: 'tool', name: choice.function.name }
  }
  return undefined
}

// The caller's choice in Anthropic's terms. A forced call (`any`, one named
// tool) is relaxed to `auto` for the models that refuse one
// (model-rules.ts); `parallel_tool_calls: false` — the Codex CLI's Lite
// setting — becomes `disable_parallel_tool_use`, which Anthropic carries on
// the choice and so needs one even when the caller gave none.
function toolChoiceOf(choice: UnifiedChatRequest['tool_choice'], model: string, parallel: boolean): Block | undefined {
  const base = baseToolChoice(choice)
  const forced = base !== undefined && (base.type === 'any' || base.type === 'tool')
  const allowed = forced && !acceptsForcedToolChoice(model) ? { type: 'auto' } : base
  if (parallel || allowed?.type === 'none') return allowed
  return { ...(allowed === undefined ? { type: 'auto' } : allowed), disable_parallel_tool_use: true }
}

// Chat spells it on the body; the Responses inbound consumes the field, so
// for that surface it is read off the caller's own body.
function allowsParallelCalls(request: Record<string, unknown>, context: TransformerContext): boolean {
  if (request.parallel_tool_calls === false) return false
  const inbound = context?.req?.body
  return !(isObject(inbound) && inbound.parallel_tool_calls === false)
}

// ─── Parameters ────────────────────────────────────────────────────────

function maxTokensOf(request: Record<string, unknown>): number {
  const stated = [request.max_tokens, request.max_completion_tokens, request.max_output_tokens].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1
  )
  return stated === undefined ? DEFAULT_MAX_TOKENS : Math.floor(stated)
}

function stopSequencesOf(stop: unknown): string[] {
  const listed = typeof stop === 'string' ? [stop] : Array.isArray(stop) ? stop : []
  return listed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

// OpenAI's temperature runs 0–2, Anthropic's 0–1, so it is clamped rather
// than sent out of range. Only one of the two is sent: the Claude 4 models
// that still take sampling parameters refuse `temperature` and `top_p`
// together.
function samplingOf(request: Record<string, unknown>, model: string): Block {
  if (!acceptsSamplingParams(model)) return {}
  if (typeof request.temperature === 'number') return { temperature: Math.min(Math.max(request.temperature, 0), 1) }
  return typeof request.top_p === 'number' ? { top_p: request.top_p } : {}
}

const continuesToolLoop = (turns: readonly Turn[]): boolean => {
  const last = turns.at(-1)
  return last?.role === 'user' && last.content.some((block) => block.type === 'tool_result')
}

// See "Thinking" at the top of this file.
function thinkingOf(request: Record<string, unknown>, turns: readonly Turn[], maxTokens: number): Block | undefined {
  const thinking = request.thinking
  if (!isObject(thinking) || typeof thinking.type !== 'string') return undefined
  if (thinking.type !== 'enabled') return { ...thinking }
  const budget = thinking.budget_tokens
  if (typeof budget !== 'number' || budget >= maxTokens || continuesToolLoop(turns)) return undefined
  return { ...thinking }
}

// The caller's effort, when the model's own list says it takes that level
// (recorded per subscription model; absent, it is left out — Haiku 4.5
// refuses the field). A per-model manual effort wins over the caller's,
// as it does on every other outbound.
function effortOf(request: Record<string, unknown>, provider: RuntimeProvider, model: string): string | undefined {
  const supported = provider.modelSupportedEfforts?.[model]
  const manual = provider.modelReasoningEfforts?.[model]
  const reasoning = request.reasoning
  const asked = manual !== undefined && manual !== 'auto' ? manual : isObject(reasoning) ? reasoning.effort : undefined
  return typeof asked === 'string' && supported?.some((level) => level === asked) === true ? asked : undefined
}

// A strict JSON schema the caller asked the answer to follow — Chat's
// `response_format` or Responses' `text.format`. Only a strict one is sent:
// Anthropic's structured output enforces the schema, and a schema written
// for OpenAI's non-strict mode need not meet the rules that requires.
function formatOf(request: Record<string, unknown>): Block | undefined {
  const chat = request.response_format
  if (isObject(chat) && chat.type === 'json_schema' && isObject(chat.json_schema)) {
    const spec = chat.json_schema
    return spec.strict === true && isObject(spec.schema) ? { type: 'json_schema', schema: spec.schema } : undefined
  }
  const text = request.text
  const format = isObject(text) ? text.format : undefined
  if (!isObject(format) || format.type !== 'json_schema') return undefined
  return format.strict === true && isObject(format.schema) ? { type: 'json_schema', schema: format.schema } : undefined
}

function outputConfigOf(request: Record<string, unknown>, provider: RuntimeProvider, model: string): Block | undefined {
  const effort = effortOf(request, provider, model)
  const format = formatOf(request)
  if (effort === undefined && format === undefined) return undefined
  return { ...(effort === undefined ? {} : { effort }), ...(format === undefined ? {} : { format }) }
}

// ─── Prompt caching ────────────────────────────────────────────────────

// Anthropic allows four cache breakpoints per request.
const MAX_BREAKPOINTS = 4

const hasBreakpoint = (block: unknown): boolean => isObject(block) && isObject(block.cache_control)

/**
 * Cache breakpoints where an OpenAI-family caller has none to give.
 *
 * OpenAI caches a repeated prompt prefix by itself; Anthropic caches only
 * up to a `cache_control` breakpoint, and an OpenAI wire format has no way
 * to place one. Without them every turn of a long agent session — the
 * Codex CLI's, re-sending its whole history each time — is billed as fresh
 * input. So the stable parts get one each, the way Claude Code places its
 * own: the tool list, the system prompt, and the last block of the
 * conversation, which the next turn's prefix will contain. Breakpoints a
 * caller did set are kept and counted against the limit; a prefix too
 * short to cache is simply not cached.
 */
function addCacheBreakpoints(body: Record<string, unknown>, turns: readonly Turn[]): void {
  const system = Array.isArray(body.system) ? body.system : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const blocks = [...system, ...tools, ...turns.flatMap((turn) => turn.content)]
  const candidates = [turns.at(-1)?.content.at(-1), system.at(-1), tools.at(-1)]
  const spare = MAX_BREAKPOINTS - blocks.filter(hasBreakpoint).length
  candidates
    .filter((block): block is Block => isObject(block) && !hasBreakpoint(block))
    .slice(0, Math.max(spare, 0))
    .forEach((block) => {
      block.cache_control = { type: 'ephemeral' }
    })
}

/**
 * The Anthropic Messages body for a unified request.
 *
 * `max_tokens` is always present — Anthropic requires it — and defaults to
 * DEFAULT_MAX_TOKENS when the caller set no cap.
 */
export function convertUnifiedToAnthropic(
  input: UnifiedChatRequest,
  provider: RuntimeProvider,
  context: TransformerContext
): Record<string, unknown> {
  const request = lowerResponsesTools(input)
  const fields: Record<string, unknown> = { ...request }
  const model = request.model
  const messages = Array.isArray(request.messages) ? request.messages : []
  const turns = turnsOf(messages)
  const maxTokens = maxTokensOf(fields)

  const body: Record<string, unknown> = { model, max_tokens: maxTokens }
  const system = systemBlocks(fields, messages)
  if (system.length > 0) body.system = system
  body.messages = turns

  const tools = (Array.isArray(request.tools) ? request.tools : []).filter(isUnifiedFunctionTool).map(toolDefinition)
  if (tools.length > 0) {
    body.tools = tools
    const choice = toolChoiceOf(request.tool_choice, model, allowsParallelCalls(fields, context))
    if (choice !== undefined) body.tool_choice = choice
  }

  const stops = stopSequencesOf(fields.stop)
  if (stops.length > 0) body.stop_sequences = stops
  Object.assign(body, samplingOf(fields, model))
  const thinking = thinkingOf(fields, turns, maxTokens)
  if (thinking !== undefined) body.thinking = thinking
  const outputConfig = outputConfigOf(fields, provider, model)
  if (outputConfig !== undefined) body.output_config = outputConfig
  if (request.stream === true) body.stream = true
  addCacheBreakpoints(body, turns)
  return body
}

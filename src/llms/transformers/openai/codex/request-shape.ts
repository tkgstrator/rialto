/**
 * The body of a request to the Codex backend, in the shape Codex CLI
 * 0.158.0 sends for a model on the classic Responses shape (captured from
 * `codex exec` against a local server; `gpt-5.5` in the CLI's catalog).
 *
 * openai-responses has already built a Responses body. What the CLI does
 * differently:
 *   - A caller's system prompt is developer instructions: one `developer`
 *     message, first in `input`. `instructions` is the CLI's base prompt,
 *     which only a Responses client writes. This is also what lets
 *     `text.format: json_object` through: the backend looks for the word
 *     "json" in input messages and not in `instructions`, so a system
 *     prompt lifted into `instructions` used to take the word out of reach
 *     (400 "Response input messages must contain the word 'json'").
 *   - Every input message is a typed `message` item with content parts.
 *   - Encrypted reasoning is asked for, and handed back on the next turn.
 *   - `tool_choice: 'auto'`, parallel tool calls, `text.verbosity: 'low'`.
 *   - Only the top-level fields the CLI sends. The backend allow-lists them:
 *     it answered `max_output_tokens` with 400 "Unsupported parameter" (#463).
 *
 * Not reproduced: the CLI sends its `gpt-5.6-*` / `gpt-6-*` models the
 * "Responses Lite" shape — no `instructions` or top-level `tools`, the tools
 * in an `additional_tools` input item. Rialto has sent those models the
 * classic shape all along; the Lite shape waits on a check against the real
 * backend.
 */

import type { PipelineRequest } from '@/schemas/domain/pipeline'
import { openCodexReasoning } from '../../../utils/codex-reasoning'
import { isObject } from '../../../utils/guards'

// `instructions` is required. The CLI fills it with its own base prompt —
// an agent persona describing tools a Rialto request does not have — so a
// caller that is not the CLI gets this instead.
export const NEUTRAL_INSTRUCTIONS = 'You are a helpful assistant.'

export type CodexCallerIntent = {
  // The caller wrote Responses `instructions` itself: a Responses client
  // such as the Codex CLI, whose instructions are its base prompt.
  writesInstructions: boolean
  parallelToolCalls: boolean
  // Set only when the caller asked for one; the CLI's default is none.
  reasoningSummary: string | undefined
}

/**
 * What the caller asked for that the unified request no longer says. It is
 * read off the inbound body, whose format the surface names.
 */
export function codexCallerIntent(req: PipelineRequest | undefined): CodexCallerIntent {
  const surface = req?.surface
  const body = isObject(req?.body) ? req.body : {}
  const responsesClient = surface === 'openai-responses'
  const reasoning = body.reasoning
  const summary = responsesClient && isObject(reasoning) ? reasoning.summary : undefined
  return {
    writesInstructions: responsesClient,
    parallelToolCalls: allowsParallelToolCalls(surface, body),
    reasoningSummary: typeof summary === 'string' ? summary : undefined
  }
}

// The CLI sends `parallel_tool_calls: true` for every model in its catalog;
// only a caller that turned them off gets false.
function allowsParallelToolCalls(surface: PipelineRequest['surface'], body: Record<string, unknown>): boolean {
  if (surface === 'anthropic-messages') {
    const choice = body.tool_choice
    return !(isObject(choice) && choice.disable_parallel_tool_use === true)
  }
  // Chat Completions and Responses spell it the same.
  return body.parallel_tool_calls !== false
}

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return content.length > 0 ? [content] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((part) =>
    isObject(part) && typeof part.text === 'string' && part.text.length > 0 ? [part.text] : []
  )
}

function isMessage(item: unknown): item is Record<string, unknown> {
  return isObject(item) && typeof item.role === 'string' && (item.type === undefined || item.type === 'message')
}

const isSystemMessage = (item: unknown): item is Record<string, unknown> => isMessage(item) && item.role === 'system'

// The caller's system prompt — lifted into `instructions` when it was one
// string, left as `system` items when it was several blocks — as the one
// developer message the CLI starts its input with.
function developerInstructions(instructions: unknown, input: unknown[]): unknown[] {
  const parts = [...textOf(instructions), ...input.filter(isSystemMessage).flatMap((item) => textOf(item.content))]
  if (parts.length === 0) return []
  return [{ type: 'message', role: 'developer', content: parts.map((text) => ({ type: 'input_text', text })) }]
}

function messageParts(content: unknown, role: unknown): unknown[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return content.length > 0 ? [{ type: textType, text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (typeof part === 'string') return part.length > 0 ? [{ type: textType, text: part }] : []
    if (!isObject(part)) return []
    if (part.type !== 'text') return [part]
    return typeof part.text === 'string' && part.text.length > 0 ? [{ type: textType, text: part.text }] : []
  })
}

function shapeMessage(item: Record<string, unknown>): unknown[] {
  // The CLI never sends a `system` item; a system prompt is developer text.
  const role = item.role === 'system' ? 'developer' : item.role
  const content = messageParts(item.content, role)
  if (content.length === 0) return []
  return [{ type: 'message', ...(typeof item.id === 'string' ? { id: item.id } : {}), role, content }]
}

// A reasoning item openai-responses replayed still carries the sealed
// envelope. It goes back only to the account that produced it: another
// account cannot decrypt it, and would answer the request with a 400.
function shapeReasoning(item: Record<string, unknown>, accountTag: string | null): unknown[] {
  const sealed = typeof item.encrypted_content === 'string' ? openCodexReasoning(item.encrypted_content) : null
  if (sealed === null) return [item]
  if (accountTag === null || sealed.account !== accountTag) return []
  return [{ ...item, encrypted_content: sealed.encryptedContent }]
}

function shapeInputItem(item: unknown, accountTag: string | null): unknown[] {
  if (isMessage(item)) return shapeMessage(item)
  if (isObject(item) && item.type === 'reasoning') return shapeReasoning(item, accountTag)
  return [item]
}

// The CLI states `strict: false` on each of its function tools.
function withStrict(tool: unknown): unknown {
  return isObject(tool) && tool.type === 'function' && tool.strict === undefined ? { ...tool, strict: false } : tool
}

function codexReasoning(reasoning: unknown, summary: string | undefined): Record<string, unknown> | undefined {
  if (!isObject(reasoning)) return undefined
  const shaped = {
    ...(typeof reasoning.effort === 'string' ? { effort: reasoning.effort } : {}),
    ...(summary === undefined ? {} : { summary })
  }
  return Object.keys(shaped).length > 0 ? shaped : undefined
}

function codexInclude(include: unknown): string[] {
  const asked = Array.isArray(include) ? include.filter((value): value is string => typeof value === 'string') : []
  return [...new Set([...asked, 'reasoning.encrypted_content'])]
}

// `verbosity` is Chat Completions' top-level spelling of text.verbosity.
function codexText(text: unknown, chatVerbosity: unknown): Record<string, unknown> {
  const asked = isObject(text) ? text : {}
  const verbosity =
    typeof asked.verbosity === 'string' ? asked.verbosity : typeof chatVerbosity === 'string' ? chatVerbosity : 'low'
  return { verbosity, ...asked }
}

/**
 * The CLI-shaped body, minus `prompt_cache_key` and `client_metadata`,
 * which codex-oauth derives from it. `accountTag` names the account the
 * request runs on (utils/codex-reasoning.ts), null when there is none.
 */
export function shapeCodexBody(
  body: Record<string, unknown>,
  intent: CodexCallerIntent,
  accountTag: string | null
): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : []
  const moved = intent.writesInstructions ? [] : developerInstructions(body.instructions, input)
  const kept = intent.writesInstructions ? input : input.filter((item) => !isSystemMessage(item))
  const own = typeof body.instructions === 'string' && body.instructions.length > 0 ? body.instructions : undefined
  const tools = Array.isArray(body.tools) ? body.tools.map(withStrict) : undefined
  const toolChoice = body.tool_choice !== undefined ? body.tool_choice : tools?.length ? 'auto' : undefined
  const shaped: Record<string, unknown> = {
    model: body.model,
    instructions: intent.writesInstructions && own !== undefined ? own : NEUTRAL_INSTRUCTIONS,
    input: [...moved, ...kept].flatMap((item) => shapeInputItem(item, accountTag)),
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: intent.parallelToolCalls,
    reasoning: codexReasoning(body.reasoning, intent.reasoningSummary),
    store: false,
    stream: true,
    include: codexInclude(body.include),
    service_tier: typeof body.service_tier === 'string' ? body.service_tier : undefined,
    text: codexText(body.text, body.verbosity)
  }
  for (const key of Object.keys(shaped)) {
    if (shaped[key] === undefined) delete shaped[key]
  }
  return shaped
}

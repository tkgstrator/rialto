/**
 * Gemini routing signals: what a `/v1beta/models/*` request tells the
 * tier router.
 *
 * The router's context-window and web-search gates ask their questions
 * in one normalised vocabulary (`RouterSignals`). Read in the Anthropic
 * one, every Gemini request answers them with "nothing": `contents[]`
 * counts as zero tokens and a `googleSearch` tool goes unseen, so
 * neither gate could ever hold a Gemini request back.
 *
 * The extraction runs through `inbound-request.ts` — the same converter
 * the routed path uses to turn a Gemini body into the unified shape —
 * rather than walking `contents[]` a second time. Routing and conversion
 * therefore cannot disagree about what a request contains: a body the
 * converter reads as three turns and a tool result is counted here as
 * three turns and a tool result, and every snake_case alias Google
 * accepts is collapsed in exactly one place.
 */

import type { RouterSignals } from '@/llms/router/surface-signals'
import type { TokenizeContentBlock, TokenizeMessage, TokenizeTool } from '@/schemas/domain/tokenizer'
import type { UnifiedMessage } from '@/schemas/domain/unified'
import type { GeminiInboundFunctionDeclaration, GeminiInboundTool } from '@/schemas/wire/gemini/content'
import { GeminiInboundRequestSchema } from '@/schemas/wire/gemini/content'
import { createToolCallLedger, firstPresent, inboundContentToMessages, inboundSystemMessage } from './inbound-request'

/**
 * The slice of an inbound Gemini body the router branches on.
 *
 * Picked off the full inbound schema rather than restated so the aliases
 * stay in one file, and picked rather than reused whole because the full
 * schema requires `model` — which the surface folds in from the URL
 * *after* the body is read. Signals must survive a body that has not
 * been through that step (a hand-built RouterRequest in a test, say).
 */
const GeminiSignalFieldsSchema = GeminiInboundRequestSchema.pick({
  contents: true,
  systemInstruction: true,
  system_instruction: true,
  tools: true,
  // Validated but no longer read: the thinking config only fed signals
  // the router has dropped. Kept in the pick so a body whose generation
  // config the converter will reject still yields no signals, as it did
  // while the config was read.
  generationConfig: true,
  generation_config: true
})

/**
 * Keys on a `tools[]` entry that are not a built-in tool.
 *
 * Everything else on the entry is one: Gemini names its built-ins by the
 * key they occupy (`googleSearch`, `urlContext`, `codeExecution`), so
 * the set cannot be enumerated ahead of Google shipping the next one.
 */
const NON_BUILTIN_TOOL_KEYS: ReadonlySet<string> = new Set(['functionDeclarations', 'function_declarations'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The built-in tools attached to one `tools[]` entry, by their own key. */
const builtinToolKeys = (tool: GeminiInboundTool): string[] =>
  Object.keys(tool).filter((key) => !NON_BUILTIN_TOOL_KEYS.has(key))

/**
 * Google's built-in search tool, in every spelling the API has shipped:
 * `googleSearch` (Gemini 2+), `googleSearchRetrieval` (1.5), and the
 * snake_case proto name of either. Matched on a normalised prefix rather
 * than an exact list for the same reason `thinkingLevel` is read as a
 * free string — Google adds spellings faster than we ship, and a
 * web-search gate that silently stops matching is worse than one that
 * over-matches a future `googleSearchSomething`.
 */
const isGoogleSearchKey = (key: string): boolean => key.toLowerCase().replaceAll('_', '').startsWith('googlesearch')

const hasGoogleSearch = (tools: readonly GeminiInboundTool[]): boolean =>
  tools.some((tool) => builtinToolKeys(tool).some(isGoogleSearchKey))

/**
 * A declaration's JSON schema, for the token count.
 *
 * `parametersJsonSchema` is where the newer GenAI SDKs put it; leaving
 * it unread would undercount a tool-heavy request by the whole size of
 * its schemas, which is exactly the request most likely to be near a
 * route's context window.
 */
function declarationSchema(decl: GeminiInboundFunctionDeclaration): Record<string, unknown> {
  const parameters = isRecord(decl.parameters) ? decl.parameters : undefined
  const jsonSchema = isRecord(decl.parametersJsonSchema) ? decl.parametersJsonSchema : undefined
  const schema = firstPresent(parameters, jsonSchema)
  return schema === undefined ? {} : schema
}

const tokenizeToolsOf = (tools: readonly GeminiInboundTool[]): TokenizeTool[] =>
  tools.flatMap((tool) =>
    tool.functionDeclarations.map((decl) => ({
      name: decl.name,
      description: decl.description,
      input_schema: declarationSchema(decl)
    }))
  )

/**
 * Flatten one unified message into the blocks the tokenizer counts.
 *
 * Tool-call arguments land as text rather than as a `tool_use` block on
 * purpose. The count comes out the same as the Anthropic path (which
 * counts a `tool_use` block's `input` and nothing else), and the
 * api-backed tokenizer POSTs this envelope to a real provider endpoint —
 * a synthetic `tool_use` block with no `id` or `name` would be rejected
 * there. Reasoning text is counted because the client replayed it, so
 * it occupies the upstream context like any other block.
 */
function tokenizeMessageOf(message: UnifiedMessage): TokenizeMessage {
  const blocks: TokenizeContentBlock[] = []
  if (typeof message.content === 'string') {
    blocks.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    }
  }
  if (message.thinking !== undefined) {
    blocks.push({ type: 'text', text: message.thinking.content })
  }
  for (const call of message.tool_calls === undefined ? [] : message.tool_calls) {
    blocks.push({ type: 'text', text: call.function.arguments })
  }
  return { role: message.role, content: blocks }
}

/** Signals for a body that does not parse as a Gemini request at all. */
const noSignals = (): RouterSignals => ({
  tokenize: { messages: [], tools: [] },
  webSearch: false
})

/**
 * Read the routing signals out of an inbound Gemini body.
 *
 * A body that fails to parse yields no signals rather than the Anthropic
 * reader's answers: this is a Gemini request, and guessing at it in
 * another vendor's vocabulary is how the surface got a permanently empty
 * token count in the first place. Such a body cannot be routed anyway —
 * `transformRequestOut` rejects it a moment later.
 */
export function readGeminiSignals(body: Record<string, unknown>): RouterSignals {
  const parsed = GeminiSignalFieldsSchema.safeParse(body)
  if (!parsed.success) return noSignals()

  const { contents, tools } = parsed.data

  const ledger = createToolCallLedger()
  const messages = contents.flatMap((content) => inboundContentToMessages(content, ledger).map(tokenizeMessageOf))
  // Gemini carries the system prompt beside `contents`, so it has to be
  // read separately or a long instruction counts as nothing.
  const system = inboundSystemMessage(firstPresent(parsed.data.systemInstruction, parsed.data.system_instruction))

  return {
    tokenize: {
      messages,
      system: typeof system?.content === 'string' ? system.content : undefined,
      tools: tokenizeToolsOf(tools)
    },
    webSearch: hasGoogleSearch(tools)
  }
}

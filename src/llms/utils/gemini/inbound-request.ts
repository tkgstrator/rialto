/**
 * Gemini request shaping: inbound (`generateContent` → unified).
 *
 * The mirror image of `request-content.ts` / `request-config.ts`. This
 * half only runs when the gemini surface is `routed` — a Gemini client's
 * own request has to be understood before it can be handed to a
 * non-Gemini provider. On the bypass path (gemini surface → Google
 * provider) the body is already in the right shape and none of this
 * runs, which is why a gap here stays invisible until someone turns
 * routing on.
 *
 * Everything not read here disappears without an error, so each part
 * variant Gemini can put on the wire is handled explicitly rather than
 * falling through to a text-only default.
 */

import type {
  MessageContent,
  ThinkLevel,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedMessageRole,
  UnifiedToolCall
} from '@/schemas/domain/unified'
import { ThinkLevelSchema } from '@/schemas/domain/unified'
import type {
  GeminiInboundContent,
  GeminiInboundFunctionResponse,
  GeminiInboundGenerationConfig,
  GeminiInboundPart,
  GeminiInboundThinkingConfig,
  GeminiInboundToolConfig
} from '@/schemas/wire/gemini/content'
import { getThinkLevel } from '../thinking'

/** Media type used when a blob or file reference omits its own. */
const FALLBACK_MEDIA_TYPE = 'application/octet-stream'

/**
 * Pairing state for one request's walk over `contents[]`.
 *
 * A `functionResponse` has to name the `functionCall` it answers, but
 * Gemini's id field is optional and its SDKs usually omit it — the two
 * are matched by function name in arrival order instead. `minted` only
 * ever grows so a second call to the same function cannot be handed an
 * id that an earlier turn already used; `pending` is the FIFO queue the
 * responses draw from.
 */
type ToolCallLedger = {
  readonly minted: Map<string, number>
  readonly pending: Map<string, string[]>
}

export const createToolCallLedger = (): ToolCallLedger => ({ minted: new Map(), pending: new Map() })

const pendingFor = (ledger: ToolCallLedger, name: string): string[] => {
  const queue = ledger.pending.get(name)
  return queue === undefined ? [] : queue
}

/** Mint (or adopt) the id for one `functionCall` and queue it for pairing. */
function claimCallId(ledger: ToolCallLedger, name: string, explicitId: string | undefined): string {
  const seq = ledger.minted.get(name)
  const ordinal = seq === undefined ? 0 : seq
  const id = explicitId === undefined ? `gemini_call_${name}_${ordinal}` : explicitId
  ledger.minted.set(name, ordinal + 1)
  ledger.pending.set(name, [...pendingFor(ledger, name), id])
  return id
}

/** Resolve the call id one `functionResponse` answers. */
function resolveResponseId(ledger: ToolCallLedger, name: string, explicitId: string | undefined): string {
  if (explicitId !== undefined) {
    return explicitId
  }
  const [head, ...rest] = pendingFor(ledger, name)
  if (head === undefined) {
    // A tool result whose call is not in this request — Gemini clients
    // are free to trim old turns. Keep the payload addressable instead
    // of dropping it on the floor.
    return `gemini_call_${name}_orphan`
  }
  ledger.pending.set(name, rest)
  return head
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Collapse the camelCase / snake_case spellings of one alias pair. */
export function firstPresent<T>(primary: T | undefined, alias: T | undefined): T | undefined {
  return primary === undefined ? alias : primary
}

/**
 * Build the unified image block for a media part, or `undefined` when
 * the part carries no media.
 *
 * Inline blobs become `data:` URLs because that is what the unified
 * `image_url` block carries; `request-content.ts` splits them back at
 * the comma, so a Gemini → Gemini round trip is lossless.
 */
function imageBlockOf(part: GeminiInboundPart): MessageContent | undefined {
  const inline = firstPresent(part.inlineData, part.inline_data)
  if (inline?.data !== undefined) {
    const mediaType = firstPresent(inline.mimeType, inline.mime_type)
    const media = mediaType === undefined ? FALLBACK_MEDIA_TYPE : mediaType
    return { type: 'image_url', image_url: { url: `data:${media};base64,${inline.data}` }, media_type: media }
  }
  const file = firstPresent(part.fileData, part.file_data)
  const uri = file === undefined ? undefined : firstPresent(file.fileUri, file.file_uri)
  if (file === undefined || uri === undefined) {
    return undefined
  }
  const mediaType = firstPresent(file.mimeType, file.mime_type)
  const media = mediaType === undefined ? FALLBACK_MEDIA_TYPE : mediaType
  return { type: 'image_url', image_url: { url: uri }, media_type: media }
}

/**
 * Flatten a `functionResponse.response` payload into the string the
 * unified `tool` message carries.
 *
 * `{ result: … }` is the envelope our own outbound builder emits, so
 * unwrapping it keeps a Gemini round trip lossless. Anything else is
 * stringified rather than discarded.
 */
function toolResultContent(response: unknown): string | null {
  if (response === undefined || response === null) {
    return null
  }
  if (typeof response === 'string') {
    return response.length > 0 ? response : null
  }
  if (isPlainRecord(response) && typeof response.result === 'string') {
    return response.result.length > 0 ? response.result : null
  }
  return JSON.stringify(response)
}

function toolResultMessage(fnResponse: GeminiInboundFunctionResponse, ledger: ToolCallLedger): UnifiedMessage {
  const name = fnResponse.name === undefined ? 'function' : fnResponse.name
  return {
    role: 'tool',
    tool_call_id: resolveResponseId(ledger, name, fnResponse.id),
    content: toolResultContent(fnResponse.response)
  }
}

/** Everything one `parts[]` array contributes to the unified messages. */
type HarvestedParts = {
  readonly blocks: MessageContent[]
  readonly toolCalls: UnifiedToolCall[]
  readonly toolMessages: UnifiedMessage[]
  readonly thoughts: string[]
  readonly signatures: string[]
}

/**
 * Build the unified tool call for a `functionCall` part, or `undefined`
 * when the part is not one. A nameless call is dropped: the unified
 * shape has nothing to address it by, and Gemini never emits one.
 */
function toolCallOf(part: GeminiInboundPart, ledger: ToolCallLedger): UnifiedToolCall | undefined {
  const call = part.functionCall
  if (call?.name === undefined) {
    return undefined
  }
  return {
    id: claimCallId(ledger, call.name, call.id),
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) }
  }
}

/**
 * Route one text part.
 *
 * Reasoning parts (`thought: true`) are pulled out of the visible body
 * and put on the message's `thinking` field — leaving them in `content`
 * would replay the model's private reasoning to the next provider as if
 * the user had written it. Empty text is dropped rather than turned
 * into an empty block, which the unified `TextContent` shape rejects.
 */
function harvestText(harvested: HarvestedParts, text: string, thought: boolean): void {
  if (text.length === 0) {
    return
  }
  if (thought) {
    harvested.thoughts.push(text)
    return
  }
  harvested.blocks.push({ type: 'text', text })
}

/** Sort one part into its unified destination. */
function harvestPart(harvested: HarvestedParts, part: GeminiInboundPart, ledger: ToolCallLedger): void {
  if (part.thoughtSignature !== undefined) {
    harvested.signatures.push(part.thoughtSignature)
  }
  const toolCall = toolCallOf(part, ledger)
  if (toolCall !== undefined) {
    harvested.toolCalls.push(toolCall)
    return
  }
  if (part.functionResponse !== undefined) {
    harvested.toolMessages.push(toolResultMessage(part.functionResponse, ledger))
    return
  }
  if (typeof part.text === 'string') {
    harvestText(harvested, part.text, part.thought)
    return
  }
  const image = imageBlockOf(part)
  if (image !== undefined) {
    harvested.blocks.push(image)
  }
}

/** Sort one `parts[]` array into its unified destinations. */
function harvestParts(parts: readonly GeminiInboundPart[], ledger: ToolCallLedger): HarvestedParts {
  const harvested: HarvestedParts = { blocks: [], toolCalls: [], toolMessages: [], thoughts: [], signatures: [] }
  for (const part of parts) {
    harvestPart(harvested, part, ledger)
  }
  return harvested
}

/** Assemble the unified messages one Gemini `content` entry produces. */
function messagesFromParts(
  role: UnifiedMessageRole,
  parts: readonly GeminiInboundPart[],
  ledger: ToolCallLedger
): UnifiedMessage[] {
  const { blocks, toolCalls, toolMessages, thoughts, signatures } = harvestParts(parts, ledger)
  const messages: UnifiedMessage[] = []
  if (blocks.length > 0 || toolCalls.length > 0 || thoughts.length > 0) {
    const message: UnifiedMessage = { role, content: blocks.length > 0 ? blocks : null }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }
    if (thoughts.length > 0) {
      const [signature] = signatures
      message.thinking =
        signature === undefined ? { content: thoughts.join('\n') } : { content: thoughts.join('\n'), signature }
    }
    messages.push(message)
  }
  messages.push(...toolMessages)
  return messages
}

/**
 * Convert one inbound Gemini `contents[]` entry into unified messages.
 *
 * One entry can produce several: a turn carrying `functionResponse`
 * parts becomes one `tool` message per part, because unified follows
 * OpenAI's one-result-per-message convention while Gemini packs them
 * into a single user turn.
 */
export function inboundContentToMessages(content: GeminiInboundContent, ledger: ToolCallLedger): UnifiedMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }]
  }
  // Gemini treats an omitted role as `user`; only `model` maps to the
  // assistant. Dropping role-less entries (what this used to do) throws
  // away the first turn of every request built with the shorthand.
  const role: UnifiedMessageRole = content.role === 'model' ? 'assistant' : 'user'
  if (content.parts.length > 0) {
    return messagesFromParts(role, content.parts, ledger)
  }
  if (content.text !== undefined && content.text.length > 0) {
    return [{ role, content: content.text }]
  }
  return []
}

/** Flatten a `systemInstruction` block into its prompt text. */
function systemTextOf(instruction: GeminiInboundContent): string {
  if (typeof instruction === 'string') {
    return instruction
  }
  const fromParts = instruction.parts
    .flatMap((part) => (typeof part.text === 'string' && part.text.length > 0 ? [part.text] : []))
    .join('\n')
  if (fromParts.length > 0) {
    return fromParts
  }
  return instruction.text === undefined ? '' : instruction.text
}

/**
 * Convert `systemInstruction` into the unified `system` message.
 *
 * Every other surface lands its system prompt as a plain string, so the
 * parts are joined rather than kept as blocks — nothing downstream
 * distinguishes them, and a string is what the OpenAI/Anthropic
 * outbound transformers already know how to place.
 */
export function inboundSystemMessage(instruction: GeminiInboundContent | undefined): UnifiedMessage | undefined {
  if (instruction === undefined) {
    return undefined
  }
  const text = systemTextOf(instruction)
  return text.length > 0 ? { role: 'system', content: text } : undefined
}

/**
 * Map `thinkingConfig` onto a unified reasoning effort.
 *
 * `thinkingLevel` (Gemini 3) is already the unified vocabulary. Older
 * models express the same thing as a token budget, which goes through
 * the same bucketing the `/v1/messages` surface uses for Anthropic's
 * `budget_tokens` — the two surfaces must not disagree about what
 * "8192 tokens of thinking" means.
 */
// Gemini's -1 budget is "dynamic thinking": think, and let the model decide
// how much. The shared budget bucketing reads every budget at or below 0 as
// "none" — right for Anthropic's, where only 0 exists — so this one is
// caught first, or a client asking Gemini to think got thinking switched
// off upstream.
const DYNAMIC_THINKING_BUDGET = -1

function inboundEffort(thinking: GeminiInboundThinkingConfig): ThinkLevel | undefined {
  const level = ThinkLevelSchema.safeParse(thinking.thinkingLevel)
  if (level.success) {
    return level.data
  }
  if (thinking.thinkingBudget !== undefined && thinking.thinkingBudget !== DYNAMIC_THINKING_BUDGET) {
    return getThinkLevel(thinking.thinkingBudget)
  }
  return undefined
}

/** Build the unified `reasoning` block from `generationConfig`. */
export function inboundReasoning(config: GeminiInboundGenerationConfig | undefined): UnifiedChatRequest['reasoning'] {
  const thinking = config?.thinkingConfig
  if (thinking === undefined) {
    return undefined
  }
  const effort = inboundEffort(thinking)
  const dynamic = thinking.thinkingBudget === DYNAMIC_THINKING_BUDGET
  // `includeThoughts` on its own, or a dynamic budget, asks for thinking
  // without saying how much to spend — unified spells that as enabled with
  // no effort hint.
  if (effort === undefined && !thinking.includeThoughts && !dynamic) {
    return undefined
  }
  const reasoning: NonNullable<UnifiedChatRequest['reasoning']> = { enabled: effort !== 'none' }
  if (effort !== undefined) {
    reasoning.effort = effort
  }
  if (thinking.thinkingBudget !== undefined && !dynamic) {
    reasoning.max_tokens = thinking.thinkingBudget
  }
  return reasoning
}

/**
 * Map `toolConfig.functionCallingConfig` onto the unified `tool_choice`
 * — the exact inverse of `buildToolConfig`. Gemini spells the modes in
 * upper case on the wire and our own builder emits lower case, so the
 * comparison is case-folded.
 */
export function inboundToolChoice(toolConfig: GeminiInboundToolConfig | undefined): UnifiedChatRequest['tool_choice'] {
  const config = toolConfig?.functionCallingConfig
  if (config?.mode === undefined) {
    return undefined
  }
  const mode = config.mode.toUpperCase()
  if (mode === 'NONE') {
    return 'none'
  }
  if (mode === 'AUTO') {
    return 'auto'
  }
  if (mode !== 'ANY') {
    return undefined
  }
  const [only, ...rest] = config.allowedFunctionNames
  if (only !== undefined && rest.length === 0) {
    return { type: 'function', function: { name: only } }
  }
  return 'required'
}

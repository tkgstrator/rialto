/**
 * Responses-only tools, lowered for the wire formats that have only
 * functions — and raised back on the way out.
 *
 * A Responses caller can declare three kinds of tool no other wire format
 * has: a `namespace` (`{type:'namespace', name, tools:[…]}`, a group whose
 * members are called by name within it), a `custom` tool (`{type:'custom',
 * name, format}`, called with free text rather than a JSON object), and
 * hosted ones (`local_shell`, `image_generation`, …). The Codex CLI's Lite
 * shape declares nothing else: its shell is `exec`, a custom tool with a
 * lark grammar inside the `functions` namespace. Chat Completions,
 * Anthropic Messages and Gemini take function tools only, so sent
 * verbatim each of these is a 400, and dropped the model runs with no way
 * to act.
 *
 * Lowering turns each one into a function tool the model can call:
 *
 *   - a namespace member becomes a top-level function of its own;
 *   - a custom tool becomes a function taking one string, `input`, whose
 *     description carries the tool's grammar so the model can write valid
 *     input without the grammar-constrained decoding its own upstream had;
 *   - a hosted tool is dropped (`web_search` never gets here as one: the
 *     Responses inbound already made it the `web_search` function every
 *     outbound knows).
 *
 * Calls in history are lowered the same way — a custom call's text becomes
 * `{"input": …}` arguments — and a call coming back is raised to the shape
 * the caller declared (`raisedCallOf`). Both directions compute the mapping
 * from the declared tool list alone (`toolLoweringOf`), so the response
 * side, which only has the caller's original body to go on, arrives at the
 * same names the request side sent.
 */

import {
  isUnifiedFunctionTool,
  type UnifiedChatRequest,
  type UnifiedFunctionTool,
  type UnifiedMessage,
  type UnifiedTool,
  type UnifiedToolCall
} from '@/schemas/domain/unified'
import { isObject } from './guards'

/** One tool as the function-only wire sees it, and what it was declared as. */
export type LoweredTool = {
  // The function name sent upstream, and the one the model calls back.
  readonly wireName: string
  // The name the caller declared, and the namespace it sits in.
  readonly name: string
  readonly namespace: string | undefined
  readonly kind: 'function' | 'custom'
  // False for a top-level function tool, which goes upstream verbatim and
  // comes back as it went; true for anything this module reshaped.
  readonly lowered: boolean
}

export type ToolLowering = {
  readonly byWireName: ReadonlyMap<string, LoweredTool>
  readonly byOrigin: ReadonlyMap<string, LoweredTool>
}

/** Nothing was lowered: every call is handed back as the upstream made it. */
export const NO_TOOL_LOWERING: ToolLowering = { byWireName: new Map(), byOrigin: new Map() }

// What a declaration is, before it has a wire name.
type Declared = {
  readonly name: string
  readonly namespace: string | undefined
  readonly kind: 'function' | 'custom'
  // The declaration itself: a unified function tool for a top-level one, the
  // flat Responses member/tool object for anything to be lowered.
  readonly source: Record<string, unknown>
  readonly verbatim: UnifiedFunctionTool | undefined
}

const originKey = (namespace: string | undefined, name: string): string =>
  namespace === undefined ? name : `${namespace}\u0000${name}`

// The intersection of what the three function-only wire formats accept as
// a function name: Chat and Anthropic `^[a-zA-Z0-9_-]{1,64}$`, and Gemini
// additionally wants a letter or underscore first. Only names this module
// produces are fitted to it; a caller's own top-level function goes out as
// it always did.
const MAX_NAME = 64
function wireSafe(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const led = /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`
  return led.slice(0, MAX_NAME)
}

// A free name close to `preferred`. A clash is only possible between two
// lowered names that sanitise alike, or a namespaced name equal to a
// caller's own; the suffix keeps both callable and the mapping a function
// of the declared list.
function unclaimed(preferred: string, taken: ReadonlySet<string>): string {
  if (!taken.has(preferred)) return preferred
  const candidates = Array.from({ length: taken.size + 1 }, (_, i) => {
    const suffix = `_${i + 2}`
    return `${preferred.slice(0, MAX_NAME - suffix.length)}${suffix}`
  })
  const free = candidates.find((candidate) => !taken.has(candidate))
  return free === undefined ? preferred : free
}

function memberDeclaration(member: unknown, namespace: string): Declared[] {
  if (!isObject(member) || typeof member.name !== 'string' || member.name.length === 0) return []
  if (member.type !== 'function' && member.type !== 'custom') return []
  return [{ name: member.name, namespace, kind: member.type, source: member, verbatim: undefined }]
}

// Every function-callable tool one unified tool stands for. A namespace
// stands for its members, in order, so the lowered list keeps the
// declared order — which is part of the prompt prefix an upstream caches.
function declarationsOf(tool: UnifiedTool): Declared[] {
  if (isUnifiedFunctionTool(tool)) {
    // The guard reads only that `function` is an object; the name is what
    // everything here keys on, so it is checked rather than trusted.
    const fnName: unknown = tool.function.name
    if (typeof fnName !== 'string' || fnName.length === 0) return []
    return [{ name: fnName, namespace: undefined, kind: 'function', source: {}, verbatim: tool }]
  }
  const name: unknown = Reflect.get(tool, 'name')
  if (typeof name !== 'string' || name.length === 0) return []
  if (tool.type === 'namespace') {
    const members: unknown = Reflect.get(tool, 'tools')
    return Array.isArray(members) ? members.flatMap((member) => memberDeclaration(member, name)) : []
  }
  if (tool.type !== 'custom') return []
  return [{ name, namespace: undefined, kind: 'custom', source: { ...tool }, verbatim: undefined }]
}

function unifiedToolsOf(tools: unknown): UnifiedTool[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool): UnifiedTool[] => {
    if (!isObject(tool) || typeof tool.type !== 'string' || tool.type.length === 0) return []
    return [{ ...tool, type: tool.type }]
  })
}

function declaredList(tools: unknown): Declared[] {
  return unifiedToolsOf(tools).flatMap(declarationsOf)
}

/**
 * The wire name of every declared tool, decided from the list alone.
 *
 * A top-level function keeps its name. Anything lowered takes its own
 * name, fitted to the wire, when no other declared tool would end up with
 * the same one — so the model sees `exec`, `sleep`, `spawn_agent`, the
 * names the Codex prompt talks about — and `${namespace}__${name}`
 * otherwise. Top-level names are claimed first, so a namespace member can
 * never take the name of a function declared after it.
 */
export function toolLoweringOf(tools: unknown): ToolLowering {
  const declared = declaredList(tools)
  const bareCounts = countBareNames(declared)
  const taken = new Set(declared.filter((tool) => tool.verbatim !== undefined).map((tool) => tool.name))
  const byWireName = new Map<string, LoweredTool>()
  const byOrigin = new Map<string, LoweredTool>()
  for (const tool of declared) {
    const entry = tool.verbatim === undefined ? loweredEntry(tool, bareCounts, taken) : verbatimEntry(tool)
    taken.add(entry.wireName)
    byWireName.set(entry.wireName, entry)
    // The first declaration of a name wins, as `byWireName` would have it.
    const origin = originKey(entry.namespace, entry.name)
    if (!byOrigin.has(origin)) byOrigin.set(origin, entry)
  }
  return { byWireName, byOrigin }
}

function countBareNames(declared: readonly Declared[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const tool of declared) {
    const bare = wireSafe(tool.name)
    const seen = counts.get(bare)
    counts.set(bare, seen === undefined ? 1 : seen + 1)
  }
  return counts
}

function verbatimEntry(tool: Declared): LoweredTool {
  return { wireName: tool.name, name: tool.name, namespace: undefined, kind: 'function', lowered: false }
}

function loweredEntry(
  tool: Declared,
  bareCounts: ReadonlyMap<string, number>,
  taken: ReadonlySet<string>
): LoweredTool {
  const bare = wireSafe(tool.name)
  const unique = bareCounts.get(bare) === 1 && !taken.has(bare)
  const preferred = unique || tool.namespace === undefined ? bare : wireSafe(`${tool.namespace}__${tool.name}`)
  return {
    wireName: unclaimed(preferred, taken),
    name: tool.name,
    namespace: tool.namespace,
    kind: tool.kind,
    lowered: true
  }
}

// ─── Request side ──────────────────────────────────────────────────────

const EMPTY_PARAMETERS: UnifiedFunctionTool['function']['parameters'] = { type: 'object', properties: {} }

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

// What a custom tool's `input` has to be, in words, because the grammar
// that constrained it on its own upstream is not enforced here. Without it
// the model writes prose, or JSON, where the tool wants a program.
function customInputDescription(format: unknown): string {
  const plain = 'The raw input for this tool, as a plain string — not JSON, and not wrapped in quotes or code fences.'
  if (!isObject(format) || format.type !== 'grammar') return plain
  const syntax = textOf(format.syntax)
  const definition = textOf(format.definition)
  if (definition === undefined) return plain
  const named = syntax === undefined ? 'grammar' : `${syntax} grammar`
  return `${plain} It must match this ${named}:\n\n${definition}`
}

function functionParameters(value: unknown): UnifiedFunctionTool['function']['parameters'] {
  if (!isObject(value)) return EMPTY_PARAMETERS
  return { ...value, type: 'object', properties: isObject(value.properties) ? value.properties : {} }
}

function loweredDeclaration(entry: LoweredTool, source: Record<string, unknown>): UnifiedFunctionTool {
  const description = textOf(source.description)
  const parameters: UnifiedFunctionTool['function']['parameters'] =
    entry.kind === 'custom'
      ? {
          type: 'object',
          properties: { input: { type: 'string', description: customInputDescription(source.format) } },
          required: ['input'],
          additionalProperties: false
        }
      : functionParameters(source.parameters)
  return {
    type: 'function',
    function: { name: entry.wireName, description: description === undefined ? entry.name : description, parameters }
  }
}

function loweredTools(tools: unknown, lowering: ToolLowering): UnifiedFunctionTool[] {
  return declaredList(tools).flatMap((tool) => {
    if (tool.verbatim !== undefined) return [tool.verbatim]
    const entry = lowering.byOrigin.get(originKey(tool.namespace, tool.name))
    return entry === undefined ? [] : [loweredDeclaration(entry, tool.source)]
  })
}

// The wire name a call in history goes out under. A call into a tool this
// turn no longer declares is named the way it would have been — it only
// has to be well-formed, since the upstream calls nothing by it.
function wireNameOfCall(call: UnifiedToolCall, lowering: ToolLowering): string {
  const declared = lowering.byOrigin.get(originKey(call.namespace, call.function.name))
  if (declared !== undefined) return declared.wireName
  if (call.namespace !== undefined) return wireSafe(`${call.namespace}__${call.function.name}`)
  return call.type === 'custom' ? wireSafe(call.function.name) : call.function.name
}

function lowerCall(call: UnifiedToolCall, lowering: ToolLowering): UnifiedToolCall {
  if (call.type === 'function' && call.namespace === undefined) return call
  const args = call.type === 'custom' ? JSON.stringify({ input: call.function.arguments }) : call.function.arguments
  return { id: call.id, type: 'function', function: { name: wireNameOfCall(call, lowering), arguments: args } }
}

const isResponsesOnlyCall = (call: UnifiedToolCall): boolean => call.type !== 'function' || call.namespace !== undefined

// `tool_call_type` and `namespace` are the Responses-only facts a message
// can carry (UnifiedMessageSchema / UnifiedToolCallSchema); no
// function-only wire has a field for either, and Chat refuses a property
// it does not define.
function messageNeedsLowering(message: UnifiedMessage): boolean {
  if (message.tool_call_type !== undefined) return true
  return Array.isArray(message.tool_calls) && message.tool_calls.some(isResponsesOnlyCall)
}

function lowerMessage(message: UnifiedMessage, lowering: ToolLowering): UnifiedMessage {
  if (!messageNeedsLowering(message)) return message
  const { tool_call_type: _kind, ...rest } = message
  const calls = message.tool_calls
  return Array.isArray(calls) ? { ...rest, tool_calls: calls.map((call) => lowerCall(call, lowering)) } : rest
}

function choiceName(choice: unknown): string | undefined {
  if (!isObject(choice)) return undefined
  if (isObject(choice.function) && typeof choice.function.name === 'string') return choice.function.name
  return typeof choice.name === 'string' ? choice.name : undefined
}

// The caller's tool_choice, in terms of the lowered list. A choice naming a
// tool is pointed at that tool's wire name; one the function-only formats
// cannot express (Responses' `allowed_tools`, a hosted tool) relaxes to
// `auto` rather than going out as a 400.
function loweredChoice(
  choice: UnifiedChatRequest['tool_choice'],
  lowering: ToolLowering
): UnifiedChatRequest['tool_choice'] {
  if (choice === undefined || typeof choice === 'string') return choice
  const name = choiceName(choice)
  const entry = name === undefined ? undefined : [...lowering.byWireName.values()].find((tool) => tool.name === name)
  if (entry === undefined) return isObject(choice) && choice.type === 'function' ? choice : 'auto'
  return { type: 'function', function: { name: entry.wireName } }
}

function hasResponsesOnlyParts(request: UnifiedChatRequest): boolean {
  const tools = Array.isArray(request.tools) ? request.tools : []
  if (tools.some((tool) => !isUnifiedFunctionTool(tool))) return true
  const messages = Array.isArray(request.messages) ? request.messages : []
  return messages.some(messageNeedsLowering)
}

/**
 * The request with every Responses-only tool part lowered to functions:
 * declarations, calls and results in history, and tool_choice. Returned
 * as it came when there is nothing to lower, so a request that already
 * spoke in functions reaches its upstream byte for byte as before.
 *
 * With no tool left, `tools` and `tool_choice` both go: Chat and Anthropic
 * refuse a tool_choice when no tools are specified.
 */
export function lowerResponsesTools(request: UnifiedChatRequest): UnifiedChatRequest {
  if (!hasResponsesOnlyParts(request)) return request
  const lowering = toolLoweringOf(request.tools)
  const tools = loweredTools(request.tools, lowering)
  const history = Array.isArray(request.messages) ? request.messages : []
  const messages = history.map((message) => lowerMessage(message, lowering))
  const { tools: _tools, tool_choice: choice, ...rest } = request
  if (tools.length === 0) return { ...rest, messages }
  const toolChoice = loweredChoice(choice, lowering)
  return toolChoice === undefined ? { ...rest, messages, tools } : { ...rest, messages, tools, tool_choice: toolChoice }
}

// ─── Response side ─────────────────────────────────────────────────────

/** A call as the caller declared it: its kind, name and namespace. */
export type RaisedCall = {
  readonly kind: 'function' | 'custom'
  readonly name: string
  readonly namespace: string | undefined
}

/**
 * The declared identity of a call an upstream made by wire name, or null
 * when there is nothing to raise.
 *
 * Raising only fills in what is missing. A call that states a namespace,
 * or the custom kind, came from an upstream that has both — a Responses
 * one, which was sent the caller's tools verbatim — and is left exactly as
 * it came. So is a call to a top-level function, or to a name this
 * request never lowered.
 */
export function raisedCallOf(
  lowering: ToolLowering,
  call: { readonly type: unknown; readonly namespace: unknown; readonly name: unknown }
): RaisedCall | null {
  if (typeof call.namespace === 'string' && call.namespace.length > 0) return null
  if (call.type === 'custom' || typeof call.name !== 'string') return null
  const entry = lowering.byWireName.get(call.name)
  if (entry === undefined || !entry.lowered) return null
  return { kind: entry.kind, name: entry.name, namespace: entry.namespace }
}

/**
 * A lowered custom call's text, out of the `{"input": …}` arguments the
 * model wrote. Arguments that do not parse to that shape are handed over
 * as they are: the caller's tool then sees what the model actually wrote,
 * which is more use to it than nothing.
 */
export function customInputOf(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    return isObject(parsed) && typeof parsed.input === 'string' ? parsed.input : args
  } catch {
    return args
  }
}

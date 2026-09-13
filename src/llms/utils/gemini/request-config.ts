/**
 * Gemini request shaping: `generationConfig` / `toolConfig` / `tools[]`.
 *
 * Split out of `gemini-request.ts` — this half only builds the
 * "settings" portion of the outbound Gemini request body (as opposed to
 * `request-content.ts`, which builds `contents[]` from the message list).
 */

import { isUnifiedFunctionTool, type ToolChoiceFunctionObject, type UnifiedChatRequest } from '@/schemas/domain/unified'
import type { GeminiGenerationConfig, GeminiThinkingConfig, GeminiToolConfig } from '@/schemas/wire/gemini/content'
import { type GeminiFunctionDeclaration, type GeminiTool, tTool } from '../gemini-schema'

export const isToolChoiceFunctionObject = (value: unknown): value is ToolChoiceFunctionObject => {
  if (typeof value !== 'object' || value === null || !('function' in value)) {
    return false
  }
  const fn = value.function
  return typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string'
}

/** Pick the thinking budget bracket appropriate for the requested model. */
function thinkingBudgetBracketFor(model: string): readonly [number, number] {
  return model.includes('pro') ? [128, 32768] : [0, 24576]
}

/** Clamp a requested thinking budget into the model's bracket. */
function clampThinkingBudget(max_tokens: number, bracket: readonly [number, number]): number {
  if (max_tokens < bracket[0]) {
    return bracket[0]
  }
  if (max_tokens > bracket[1]) {
    return bracket[1]
  }
  return max_tokens
}

/** Build the `generationConfig` block from the request's reasoning hints. */
export function buildGenerationConfig(request: UnifiedChatRequest): GeminiGenerationConfig {
  const generationConfig: GeminiGenerationConfig = {}
  if (!request.reasoning?.effort || request.reasoning.effort === 'none') {
    return generationConfig
  }
  const thinkingConfig: GeminiThinkingConfig = { includeThoughts: true }
  if (request.model.includes('gemini-3')) {
    thinkingConfig.thinkingLevel = request.reasoning.effort
  } else {
    const bracket = thinkingBudgetBracketFor(request.model)
    const max_tokens = request.reasoning.max_tokens
    if (typeof max_tokens !== 'undefined') {
      thinkingConfig.thinkingBudget = clampThinkingBudget(max_tokens, bracket)
    }
  }
  generationConfig.thinkingConfig = thinkingConfig
  return generationConfig
}

/** Build the `toolConfig` block from the request's `tool_choice`. */
export function buildToolConfig(toolChoice: UnifiedChatRequest['tool_choice']): GeminiToolConfig | undefined {
  if (!toolChoice) {
    return undefined
  }
  const toolConfig: GeminiToolConfig = { functionCallingConfig: {} }
  if (toolChoice === 'auto') {
    toolConfig.functionCallingConfig.mode = 'auto'
  } else if (toolChoice === 'none') {
    toolConfig.functionCallingConfig.mode = 'none'
  } else if (toolChoice === 'required') {
    toolConfig.functionCallingConfig.mode = 'any'
  } else if (isToolChoiceFunctionObject(toolChoice)) {
    toolConfig.functionCallingConfig.mode = 'any'
    toolConfig.functionCallingConfig.allowedFunctionNames = [toolChoice.function.name]
  }
  return toolConfig
}

/** Build the `tools[]` slice (function declarations + optional googleSearch). */
export function buildTools(requestTools: UnifiedChatRequest['tools']): GeminiTool[] {
  const tools: GeminiTool[] = []
  // Gemini's wire format has no equivalent of the hosted tools Codex sends
  // (`namespace`, `custom`, `local_shell`) — no function signature to declare.
  // Drop them rather than inventing a declaration Gemini would reject.
  const functionTools = requestTools?.filter(isUnifiedFunctionTool)
  const functionDeclarations: GeminiFunctionDeclaration[] | undefined = functionTools
    ?.filter((tool) => tool.function.name !== 'web_search')
    ?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parametersJsonSchema: tool.function.parameters
    }))
  if (functionDeclarations?.length) {
    tools.push(tTool({ functionDeclarations }))
  }
  if (functionTools?.some((tool) => tool.function.name === 'web_search')) {
    tools.push({ googleSearch: {} })
  }
  return tools
}

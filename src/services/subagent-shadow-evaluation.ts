import type { Logger } from 'pino'
import type { TokenizeMessage } from '../llms/tokenizers/base'
import type { DecisionEvaluateRequest, DecisionEvaluateResponse } from '../schemas/api/decisions'
import type { ModelTier } from '../schemas/domain/tier-route'
import type { ReasoningEffort } from '../shared/model-reasoning-effort'
import { evaluateWithJeff } from './jeff-client'

// Keep background observations bounded independently of the playground's longer wait.
// The wait for a turn is short too: a shadow observation is optional, so when Jeff
// is busy it gives up and logs `unavailable` rather than queueing behind others.
const SHADOW_TIMEOUT_MS = 3_000
const SHADOW_MAX_WAIT_MS = 3_000
const MAX_INSTRUCTION_CHARS = 2_000
const MAX_DECISION_OPTIONS = 26
const ENGLISH_TASK_WORDS =
  /\b(?:add|analyze|build|check|change|create|debug|describe|design|explain|find|fix|implement|improve|investigate|make|refactor|remove|review|summarize|test|update|write|the|this|that|with|from|for|please)\b/i

export type ShadowCandidate = { target: string; targetTier: ModelTier; efforts: readonly ReasoningEffort[] }
type ShadowInput = { messages: TokenizeMessage[] | undefined; log: Logger; candidates?: readonly ShadowCandidate[] }
type ModelEffortOption = { key: string; target: string; effort: ReasoningEffort | null }
type Combination = { target: string; targetTier: ModelTier; effort: ReasoningEffort | null }

const TIER_DESCRIPTIONS: Record<ModelTier, string> = {
  fable: 'highest capability',
  opus: 'high capability',
  sonnet: 'balanced capability and speed',
  haiku: 'fast and lightweight'
}

/** Keep every candidate in the choice set, or skip rather than pretending a truncated set is exhaustive. */
export function modelEffortChoices(candidates: readonly ShadowCandidate[]): {
  options: ModelEffortOption[]
  criteria: Record<string, string>
} | null {
  if (candidates.some((candidate) => candidate.target.length > 160)) return null
  const combinations = candidates.flatMap((candidate): Combination[] =>
    candidate.efforts.length === 0
      ? [{ target: candidate.target, targetTier: candidate.targetTier, effort: null }]
      : [...new Set(candidate.efforts)].map((effort) => ({
          target: candidate.target,
          targetTier: candidate.targetTier,
          effort
        }))
  )
  if (combinations.length < 2 || combinations.length > MAX_DECISION_OPTIONS) return null
  const options = combinations.map((entry, index) => ({
    key: String(index + 1),
    target: entry.target,
    effort: entry.effort
  }))
  const criteria = Object.fromEntries(
    combinations.map((entry, index) => [
      String(index + 1),
      `${entry.target} — ${TIER_DESCRIPTIONS[entry.targetTier]}; reasoning effort: ${entry.effort === null ? 'vendor default' : entry.effort}`
    ])
  )
  return { options, criteria }
}

// A tool result, attachment, or mixed-content turn is not a plain instruction.
// Do not extract a text fragment from one and accidentally send tool arguments to the decision service.
export function latestPlainTextInstruction(messages: TokenizeMessage[] | undefined): string | null {
  if (messages === undefined) return null
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  if (latestUser === undefined) return null
  const { content } = latestUser
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) &&
          content.length > 0 &&
          content.every((block) => block.type === 'text' && typeof block.text === 'string')
        ? content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
        : null
  if (text === null) return null
  const instruction = text.trim()
  // This is a deliberately narrow English-only gate, not language detection.
  // False negatives are preferable to evaluating unsupported or ambiguous content.
  if (instruction.length === 0 || instruction.length > MAX_INSTRUCTION_CHARS) return null
  if (
    ![...instruction].every((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)
    }) ||
    !ENGLISH_TASK_WORDS.test(instruction)
  )
    return null
  return instruction
}

function logDecision(
  data: DecisionEvaluateResponse,
  candidates: readonly ShadowCandidate[],
  choices: ReturnType<typeof modelEffortChoices>,
  log: Logger
): void {
  const complexity = data.answers.complexity
  const answer = data.answers.modelEffort
  const selected =
    answer?.type === 'choice' ? choices?.options.find((option) => option.key === answer.choice) : undefined
  const valid = choices === null || selected !== undefined
  log.info(
    {
      outcome: complexity?.type !== 'score' || !valid ? 'invalid_answer' : 'evaluated',
      score: complexity?.type === 'score' ? complexity.score : undefined,
      confidence: complexity?.type === 'score' ? complexity.confidence : undefined,
      routedPrimary: candidates[0]?.target,
      estimatedModel: selected?.target,
      estimatedEffort:
        selected === undefined ? undefined : selected.effort === null ? 'vendor_default' : selected.effort,
      modelConfidence: answer?.type === 'choice' && selected !== undefined ? answer.confidence : undefined,
      candidateCount: candidates.length,
      optionCount: choices?.options.length,
      modelEstimateSkipped: choices === null,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens
    },
    '[shadow] subagent evaluation'
  )
}

/** Fire-and-forget telemetry. No decision can change the target, effort or upstream body. */
export function shadowEvaluateSubagent({ messages, log, candidates = [] }: ShadowInput): void {
  if (process.env.JEFF_SHADOW_ENABLED !== 'true') return
  const url = process.env.JEFF_URL?.trim()
  if (url === undefined || url.length === 0) return
  const instruction = latestPlainTextInstruction(messages)
  if (instruction === null) return
  const choices = modelEffortChoices(candidates)
  const questions: DecisionEvaluateRequest['questions'] = {
    complexity: {
      type: 'score',
      instructions: 'How much reasoning and implementation does this subagent task require?',
      criteria: ['Simple, single-step work', 'Complex, multi-step reasoning or implementation']
    },
    ...(choices === null
      ? {}
      : {
          modelEffort: {
            type: 'choice',
            instructions:
              'Which model and reasoning effort can complete the task reliably with the least unnecessary work?',
            criteria: choices.criteria
          }
        })
  }

  // The only prompt content sent is the bounded latest instruction, never system prompts,
  // previous turns, tool arguments, or the request object itself.
  void Promise.resolve()
    .then(() =>
      evaluateWithJeff(
        { state: instruction, model: 'jeff-latest', questions },
        { timeoutMs: SHADOW_TIMEOUT_MS, maxWaitMs: SHADOW_MAX_WAIT_MS }
      )
    )
    .then((result) => {
      if (!result.ok) {
        // Upstream errors may contain arbitrary text; never log them.
        log.info({ outcome: 'unavailable', routedPrimary: candidates[0]?.target }, '[shadow] subagent evaluation')
        return
      }
      logDecision(result.data, candidates, choices, log)
    })
    .catch(() => {
      // A background evaluation must never become an unhandled rejection or
      // expose a provider error containing prompt text to request logs.
      log.info({ outcome: 'unavailable', routedPrimary: candidates[0]?.target }, '[shadow] subagent evaluation')
    })
}

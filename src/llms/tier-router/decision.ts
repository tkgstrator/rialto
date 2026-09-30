/**
 * A narrow SystemOne client for choosing among the tiers that a profile can
 * actually serve. The decision endpoint never chooses a provider or model:
 * the normal route selector still applies every capability, quota and health
 * gate after this optional preference is read.
 */

import type { ModelTier } from '@/schemas/domain/tier-route'

export type DecisionConfig = {
  apiBaseUrl: string | null
  apiKeyEnv: string | null
  enabled: boolean
  minConfidence: number
  model: string | null
  timeoutMs: number
}

export type DecisionInput = {
  candidates: ModelTier[]
  hasTools: boolean
  isSubagent: boolean
  needsWebSearch: boolean
  requestedModel: string | undefined
  requestTokenCount: number | undefined
  scenario: string
  thinking: boolean
}

type DecisionAnswer = { choice: string; confidence: number }

const descriptions: Record<ModelTier, string> = {
  fable: 'Use only for the most difficult, ambiguous, or high-stakes work that needs the strongest reasoning.',
  opus: 'Use for complex multi-step implementation, debugging, or design work that needs deep reasoning.',
  sonnet: 'Use for normal coding, research, and agent work that benefits from reliable general reasoning.',
  haiku: 'Use only for straightforward, bounded, low-risk tasks where speed and cost matter most.'
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function answerOf(value: unknown, candidates: readonly ModelTier[]): DecisionAnswer | null {
  const root = record(value)
  const answers = root === null ? null : record(root.answers)
  const route = answers === null ? null : record(answers.route)
  const choice = route === null ? undefined : route.choice
  const confidence = route === null ? undefined : route.confidence
  if (typeof choice !== 'string' || !candidates.includes(choice as ModelTier)) return null
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  return { choice, confidence }
}

function endpointOf(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/systemone`
}

function criteriaOf(candidates: readonly ModelTier[]): Record<string, string> {
  return Object.fromEntries(candidates.map((tier) => [tier, descriptions[tier]]))
}

/**
 * Returns null whenever the optional service is disabled, incomplete,
 * unavailable, malformed, or not confident enough. Routing must remain
 * available when a classifier has an outage, so callers simply use their
 * profile's ordinary order in all of those cases.
 */
export async function preferredTier(
  config: DecisionConfig,
  input: DecisionInput,
  env: Record<string, string | undefined> = process.env
): Promise<ModelTier | null> {
  if (!config.enabled || config.apiBaseUrl === null || config.model === null || input.candidates.length < 2) return null
  const apiKey = config.apiKeyEnv === null ? undefined : env[config.apiKeyEnv]
  if (config.apiKeyEnv !== null && (apiKey === undefined || apiKey.length === 0)) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(endpointOf(config.apiBaseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` })
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        // This intentionally contains routing metadata only. The caller's
        // messages, source files and tool arguments remain inside Rialto.
        state: {
          has_tools: input.hasTools,
          is_subagent: input.isSubagent,
          needs_web_search: input.needsWebSearch,
          requested_model: input.requestedModel,
          request_token_count: input.requestTokenCount,
          scenario: input.scenario,
          thinking_enabled: input.thinking
        },
        questions: {
          route: {
            type: 'choice',
            instructions: 'Choose the lowest capability tier that can reliably serve this request.',
            criteria: criteriaOf(input.candidates)
          }
        }
      })
    })
    if (!response.ok) return null
    const answer = answerOf(await response.json(), input.candidates)
    return answer === null || answer.confidence < config.minConfidence ? null : (answer.choice as ModelTier)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * A narrow SystemOne client for choosing among the tiers that a profile can
 * actually serve. The decision endpoint never chooses a provider or model:
 * the normal route selector still applies every capability, quota and health
 * gate after this optional preference is read.
 */

import type { Logger } from 'pino'
import { logger } from '@/logger'
import { type RoutingDecisionObservation, RoutingDecisionObservationSchema } from '@/schemas/domain/routing-decision'
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
  // The latest user instruction, already truncated; without it the classifier
  // sees only metadata and answers the same distribution for every request.
  taskText?: string
}

type DecisionAnswer = { choice: string; confidence: number; probabilities: Record<string, number> | null }

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
  const distribution = route === null ? null : record(route.probabilities)
  const probabilities =
    distribution === null
      ? null
      : Object.fromEntries(
          candidates.flatMap((tier) => {
            const probability = distribution[tier]
            return typeof probability === 'number' &&
              Number.isFinite(probability) &&
              probability >= 0 &&
              probability <= 1
              ? [[tier, probability]]
              : []
          })
        )
  return {
    choice,
    confidence,
    probabilities: probabilities !== null && Object.keys(probabilities).length > 0 ? probabilities : null
  }
}

function endpointOf(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}/v1/systemone`
}

function criteriaOf(candidates: readonly ModelTier[]): Record<string, string> {
  return Object.fromEntries(candidates.map((tier) => [tier, descriptions[tier]]))
}

export type DecisionObserver = (observation: RoutingDecisionObservation) => void | Promise<void>

async function notifyObserver(
  observer: DecisionObserver | undefined,
  observation: unknown,
  log: Pick<Logger, 'warn'>
): Promise<void> {
  const parsed = RoutingDecisionObservationSchema.safeParse(observation)
  if (observer === undefined || !parsed.success) return
  try {
    await observer(parsed.data)
  } catch {
    // Observer failures must never re-enter the classifier's fallback path.
    log.warn({ event: 'routing_decision_capture', reason: 'observer_error' }, '[routing] decision capture failed')
  }
}

function requestBodyOf(config: DecisionConfig, input: DecisionInput): string {
  return JSON.stringify({
    model: config.model,
    // Only the latest user instruction leaves Rialto; history, source files and tool arguments stay.
    state: {
      has_tools: input.hasTools,
      is_subagent: input.isSubagent,
      needs_web_search: input.needsWebSearch,
      requested_model: input.requestedModel,
      request_token_count: input.requestTokenCount,
      scenario: input.scenario,
      thinking_enabled: input.thinking,
      task: input.taskText
    },
    questions: {
      route: {
        type: 'choice',
        instructions:
          'Read state.task, the user instruction, and choose the lowest capability tier that can reliably do that work: trivial lookups and edits need a small tier, multi-file design, debugging and architecture need a large one.',
        criteria: criteriaOf(input.candidates)
      }
    }
  })
}

function skipReason(
  config: DecisionConfig,
  input: DecisionInput,
  env: Record<string, string | undefined>
): string | null {
  if (!config.enabled) return 'disabled'
  if (config.apiBaseUrl === null) return 'missing_endpoint'
  if (config.model === null) return 'missing_model'
  if (input.candidates.length < 2) return 'insufficient_candidates'
  const apiKey = config.apiKeyEnv === null ? undefined : env[config.apiKeyEnv]
  if (config.apiKeyEnv !== null && (apiKey === undefined || apiKey.length === 0)) return 'missing_api_key'
  return null
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
  env: Record<string, string | undefined> = process.env,
  log: Pick<Logger, 'info' | 'warn'> = logger,
  observer?: DecisionObserver
): Promise<ModelTier | null> {
  const started = performance.now()
  const attempt: { requestBody: string | null; httpStatus: number | null } = { requestBody: null, httpStatus: null }
  const report = (
    outcome: 'success' | 'skipped' | 'fallback',
    reason: string,
    details: {
      tier?: string
      confidence?: number
      probabilities?: Record<string, number> | null
      httpStatus?: number
    } = {}
  ): void => {
    // Allowlist metadata: upstream bodies and exception messages can contain secrets.
    const metadata = {
      event: 'routing_decision',
      outcome,
      reason,
      scenario: input.scenario,
      candidateTiers: input.candidates,
      minConfidence: config.minConfidence,
      durationMs: Math.round(performance.now() - started),
      predictedTier: details.tier === undefined ? null : details.tier,
      probabilities: details.probabilities === undefined ? null : details.probabilities,
      chosenProbability:
        details.tier === undefined || details.probabilities == null || details.probabilities[details.tier] === undefined
          ? null
          : details.probabilities[details.tier],
      decisionAccepted: outcome === 'success',
      expectedTier: null,
      evaluationStatus: 'unrated',
      ...details
    }
    if (outcome === 'fallback') log.warn(metadata, '[routing] decision')
    else log.info(metadata, '[routing] decision')
    // Skips have no serialized request, and must not look like sent inputs.
    void notifyObserver(
      observer,
      {
        ...metadata,
        requestBody: attempt.requestBody,
        confidence: details.confidence === undefined ? null : details.confidence,
        httpStatus: attempt.httpStatus
      },
      log
    )
  }
  const reason = skipReason(config, input, env)
  if (reason !== null) {
    report('skipped', reason)
    return null
  }
  // Keep the endpoint narrowed locally after the shared configuration checks.
  if (config.apiBaseUrl === null) {
    report('skipped', 'missing_endpoint')
    return null
  }
  const apiKey = config.apiKeyEnv === null ? undefined : env[config.apiKeyEnv]

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    attempt.requestBody = requestBodyOf(config, input)
    const response = await fetch(endpointOf(config.apiBaseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` })
      },
      signal: controller.signal,
      body: attempt.requestBody
    })
    attempt.httpStatus = response.status
    if (!response.ok) {
      report('fallback', 'http_error', { httpStatus: response.status })
      return null
    }
    const value: unknown = await response.json().catch(() => undefined)
    if (value === undefined) {
      report('fallback', controller.signal.aborted ? 'timeout' : 'invalid_json')
      return null
    }
    const answer = answerOf(value, input.candidates)
    if (answer === null) {
      report('fallback', 'invalid_response')
      return null
    }
    const details = { tier: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }
    if (answer.confidence < config.minConfidence) {
      report('fallback', 'low_confidence', details)
      return null
    }
    report('success', 'accepted', details)
    return answer.choice as ModelTier
  } catch {
    report('fallback', controller.signal.aborted ? 'timeout' : 'network_error')
    return null
  } finally {
    clearTimeout(timeout)
  }
}

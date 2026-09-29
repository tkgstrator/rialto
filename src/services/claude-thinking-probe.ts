/**
 * Which "thinking off" settings a Claude model takes, at each effort.
 *
 * A caller turns thinking off with `thinking: {type: "disabled"}`, but the
 * model the request lands on is Rialto's choice, and whether it accepts
 * that is a property of the model that neither the published catalog nor
 * GET /v1/models reports: Sonnet 5 takes `disabled`, Sonnet 5.5 refuses it
 * and takes `between_tools` instead (only at effort high or below), and
 * Opus 5.5 takes neither. count_tokens validates `thinking` and
 * `output_config` exactly as /v1/messages does but runs no inference, so
 * each pair is asked there once and the verdicts kept for the model's
 * lifetime (a model id is a pinned snapshot).
 */

import type { ThinkingEffortKey, ThinkingOff } from '@/schemas/domain/model-capability'
import type { ReasoningEffort } from '../shared/model-reasoning-effort'

const COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens'
const OAUTH_BETA = 'oauth-2025-04-20'

type Verdict = 'accepted' | 'refused' | 'unknown'

async function ask(
  model: string,
  thinkingType: 'disabled' | 'between_tools' | null,
  effort: ThinkingEffortKey,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<Verdict> {
  try {
    const response = await fetchImpl(COUNT_TOKENS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        ...(thinkingType === null ? {} : { thinking: { type: thinkingType } }),
        ...(effort === 'default' ? {} : { output_config: { effort } }),
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: AbortSignal.timeout(10_000)
    })
    await response.body?.cancel().catch(() => {})
    if (response.ok) return 'accepted'
    // A 400 is the upstream judging this pair. Anything else — auth, rate
    // limit, outage — says nothing about the model.
    return response.status === 400 ? 'refused' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Ask count_tokens about every thinking-off setting at every effort the
 * model accepts, plus no effort at all. Null when any answer was not a
 * verdict, so an outage is retried later rather than recorded as a
 * refusal.
 */
export async function probeThinkingOff(
  model: string,
  efforts: readonly ReasoningEffort[],
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<ThinkingOff | null> {
  // The control: a bare request every model accepts. If even that is
  // refused, the probe itself is broken (an id the account cannot see, a
  // changed OAuth scope), and recording "refused everywhere" would strip
  // `thinking` from every request to the model.
  if ((await ask(model, null, 'default', accessToken, fetchImpl)) !== 'accepted') return null
  const keys: ThinkingEffortKey[] = ['default', ...efforts]
  const support: ThinkingOff = { disabled: [], betweenTools: [] }
  for (const [field, thinkingType] of [
    ['disabled', 'disabled'],
    ['betweenTools', 'between_tools']
  ] as const) {
    // One thinking type at a time keeps each burst to a handful of
    // requests against count_tokens' own rate limit.
    const verdicts = await Promise.all(keys.map((effort) => ask(model, thinkingType, effort, accessToken, fetchImpl)))
    if (verdicts.includes('unknown')) return null
    support[field] = keys.filter((_, index) => verdicts[index] === 'accepted')
  }
  return support
}

/**
 * Which Codex models the MCP server may call, and which one a call means.
 *
 * "Codex" here is exactly what the images surface already means by it: an
 * enabled subscription provider on the Codex backend's base URL. The
 * looser tests elsewhere (a base URL mentioning chatgpt.com, a provider
 * name containing "codex") would also admit an API-key OpenAI provider,
 * and a server that says it answers as Codex must not quietly bill one.
 */

import { getPrismaClient } from '../../db/client'
import { AuthMode } from '../../generated/prisma/client'
import type { TokenPlan } from '../../services/access-token-service'
import { getEnabledModels } from '../../services/config/enabled-models'
import { SUBSCRIPTION_PRESETS } from '../../shared/data/subscriptions'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** A `provider,model` pair on a Codex subscription provider. */
export interface CodexTarget {
  provider: string
  model: string
}

export type TargetResult = { ok: true; target: CodexTarget } | { ok: false; message: string }

export const targetId = (t: CodexTarget): string => `${t.provider},${t.model}`

// What an unnamed request is sent to when the preset's default is enabled.
const PRESET_DEFAULT = SUBSCRIPTION_PRESETS.find((p) => p.id === 'codex')?.defaultEnabledModels[0]

export async function codexProviderNames(): Promise<Set<string>> {
  const rows = await getPrismaClient().provider.findMany({
    where: { enabled: true, authMode: AuthMode.subscription, apiBaseUrl: CODEX_BASE_URL },
    select: { name: true }
  })
  return new Set(rows.map((r) => r.name))
}

/**
 * The Codex models a call may name right now, per operation.
 *
 * `getEnabledModels` already applies the gates `/v1/models` applies — the
 * provider and model are enabled and some account can authenticate — so
 * the list here never offers a model a call would then be refused on.
 */
export async function codexModels(operation: 'completion' | 'image'): Promise<CodexTarget[]> {
  const [names, enabled] = await Promise.all([codexProviderNames(), getEnabledModels(undefined, operation)])
  return enabled.filter((m) => names.has(m.provider))
}

/**
 * Resolve what a caller asked for to one Codex target.
 *
 * - `provider,model` must be exactly one of the enabled pairs.
 * - A bare model must be hosted by exactly one Codex provider; two would
 *   leave the choice of which subscription pays to chance.
 * - Nothing named: the preset's default model when it is enabled, the
 *   first enabled one otherwise.
 */
export async function resolveCodexTarget(
  operation: 'completion' | 'image',
  requested: string | undefined
): Promise<TargetResult> {
  const models = await codexModels(operation)
  if (models.length === 0) {
    const kind = operation === 'image' ? 'image model' : 'model'
    return {
      ok: false,
      message: `No Codex ${kind} is enabled. Enable one on the Codex provider's page in Rialto.`
    }
  }
  const available = `Available: ${models.map(targetId).join(', ')}.`
  if (requested === undefined) {
    const preferred = models.find((m) => operation === 'completion' && m.model === PRESET_DEFAULT)
    return { ok: true, target: preferred !== undefined ? preferred : models[0] }
  }
  const matches = requested.includes(',')
    ? models.filter((m) => targetId(m) === requested)
    : models.filter((m) => m.model === requested)
  if (matches.length === 1) return { ok: true, target: matches[0] }
  if (matches.length > 1) {
    return { ok: false, message: `"${requested}" is hosted by more than one Codex provider; name one. ${available}` }
  }
  return { ok: false, message: `"${requested}" is not an enabled Codex model. ${available}` }
}

/**
 * Whether a plan lets its token spend this target. A token without a plan
 * may spend anything the server offers.
 *
 * A plan on the /v1 surfaces swaps a model it does not list for its
 * default. That is right for a client with a stale setting, and wrong
 * here: a caller who asked Codex for a second opinion must not be
 * answered by whatever the plan defaults to.
 */
export function planAllows(plan: TokenPlan | null, target: CodexTarget): boolean {
  return plan === null || plan.models.includes(targetId(target))
}

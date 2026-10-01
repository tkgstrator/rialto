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
import { resolvePreferredProvider } from '../../services/model-provider-preference'
import { newestFirst } from '../../shared/model-version'

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** A `provider,model` pair on a Codex subscription provider. */
export interface CodexTarget {
  provider: string
  model: string
}

export type TargetResult = { ok: true; target: CodexTarget } | { ok: false; message: string }

export const targetId = (t: CodexTarget): string => `${t.provider},${t.model}`

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

/** One callable target per bare name; unresolved collisions stay out of status. */
async function chooseCodexModels(eligible: readonly CodexTarget[]): Promise<CodexTarget[]> {
  const names = [...new Set(eligible.map((target) => target.model))]
  const chosen = await Promise.all(
    names.map(async (name) => {
      const candidates = eligible.filter((target) => target.model === name)
      const resolution = await resolvePreferredProvider(
        name,
        candidates.map((target) => target.provider)
      )
      return resolution.status === 'preferred'
        ? candidates.find((target) => target.provider === resolution.provider)
        : undefined
    })
  )
  return chosen.filter((target): target is CodexTarget => target !== undefined)
}

export async function callableCodexModels(
  operation: 'completion' | 'image',
  plan: TokenPlan | null = null
): Promise<CodexTarget[]> {
  return chooseCodexModels((await codexModels(operation)).filter((target) => planAllows(plan, target)))
}

/** Qualified names remain valid for older clients; bare names use Rialto's provider priority. */
export async function resolveCodexTarget(
  operation: 'completion' | 'image',
  requested: string | undefined,
  plan: TokenPlan | null = null
): Promise<TargetResult> {
  const eligible = (await codexModels(operation)).filter((target) => planAllows(plan, target))
  if (eligible.length === 0) {
    const kind = operation === 'image' ? 'image model' : 'model'
    return { ok: false, message: `No Codex ${kind} is enabled for this token.` }
  }
  if (requested?.includes(',')) {
    const qualified = eligible.find((target) => targetId(target) === requested)
    return qualified === undefined
      ? { ok: false, message: `"${requested}" is not an enabled Codex model for this token.` }
      : { ok: true, target: qualified }
  }
  const callable = await chooseCodexModels(eligible)
  if (requested === undefined) {
    const newest = [...callable].sort((a, b) => newestFirst(a.model, b.model))[0]
    return newest === undefined
      ? { ok: false, message: 'No unambiguous Codex model is available; configure provider priority in Rialto.' }
      : { ok: true, target: newest }
  }
  const target = callable.find((model) => model.model === requested)
  if (target !== undefined) return { ok: true, target }
  const colliding = eligible.filter((model) => model.model === requested).length > 1
  return {
    ok: false,
    message: colliding
      ? `"${requested}" has multiple Codex providers; configure their priority in Rialto.`
      : `"${requested}" is not an enabled Codex model. Available: ${callable.map((model) => model.model).join(', ')}.`
  }
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

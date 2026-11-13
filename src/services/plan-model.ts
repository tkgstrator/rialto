/**
 * Which model a token's plan lets a request use.
 *
 * One answer for every surface that applies a plan, so the completion
 * proxy and image generation cannot disagree about what "listed" means.
 * The Codex MCP server answers the narrower question "may this exact
 * target be called" itself (`api/codex-mcp/targets.ts`), because it never
 * falls back to a default.
 */

import type { TokenPlan } from './access-token-auth'

export type PlanModelDecision =
  // The token has no plan: the caller's model goes through untouched.
  | { kind: 'unrestricted' }
  // The plan lists the model the request named. `model` is the qualified
  // `provider,model` id, or the bare name when several listed providers
  // host it and provider priority has to pick one.
  | { kind: 'allowed'; model: string }
  // The request named no model, so it goes where the plan says.
  | { kind: 'default'; model: string }
  // The request named a model the plan does not list. It is refused, never
  // redirected: a silent swap hid a stale client setting behind a model
  // the caller did not ask for.
  | { kind: 'denied'; message: string }

const nameOf = (id: string): string => id.slice(id.indexOf(',') + 1)

export function decidePlanModel(plan: TokenPlan | null | undefined, requested: string | undefined): PlanModelDecision {
  if (plan === null || plan === undefined) return { kind: 'unrestricted' }
  if (requested === undefined || requested.length === 0) return { kind: 'default', model: plan.defaultModel }
  if (plan.models.includes(requested)) return { kind: 'allowed', model: requested }
  if (!requested.includes(',')) {
    const matching = plan.models.filter((listed) => nameOf(listed) === requested)
    if (matching.length === 1) return { kind: 'allowed', model: matching[0] }
    if (matching.length > 1) return { kind: 'allowed', model: requested }
  }
  return {
    kind: 'denied',
    message: `Model "${requested}" is not allowed for this token. Allowed models: ${plan.models.join(', ')}.`
  }
}

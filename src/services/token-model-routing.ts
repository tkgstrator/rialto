import type { ProviderAuthMode, TokenPolicy } from '../shared/access-token-policy'
import { allowsProviderMode, allowsTokenModel, preferredAuthMode } from '../shared/access-token-policy'
import type { TokenPlan } from './access-token-auth'
import { type ProviderPreferenceOrder, preferredProviderOrder } from './model-provider-preference'

export function tokenAllowsTarget(
  plan: Pick<TokenPlan, 'models'> | null | undefined,
  policy: TokenPolicy | undefined,
  target: { provider: string; model: string; authMode: ProviderAuthMode }
): boolean {
  return (
    (plan == null || plan.models.includes(`${target.provider},${target.model}`)) &&
    allowsTokenModel(policy, target.model) &&
    allowsProviderMode(policy, target.authMode)
  )
}

export async function orderTokenProviders(
  model: string,
  candidates: readonly { provider: string; authMode: ProviderAuthMode }[],
  plan: Pick<TokenPlan, 'models'> | null | undefined,
  policy: TokenPolicy | undefined
): Promise<ProviderPreferenceOrder> {
  const allowed = candidates.filter((target) => tokenAllowsTarget(plan, policy, { ...target, model }))
  const preferred = policy === undefined ? undefined : preferredAuthMode(policy.providerMode)
  if (preferred === undefined)
    return preferredProviderOrder(
      model,
      allowed.map((target) => target.provider)
    )

  const primary = await preferredProviderOrder(
    model,
    allowed.filter((target) => target.authMode === preferred).map((target) => target.provider)
  )
  if (primary.status === 'ambiguous') return primary
  const secondary = await preferredProviderOrder(
    model,
    allowed.filter((target) => target.authMode !== preferred).map((target) => target.provider)
  )
  if (primary.status === 'unavailable') return secondary
  return secondary.status === 'preferred'
    ? { status: 'preferred', providers: [...primary.providers, ...secondary.providers] }
    : primary
}

import type { TokenPolicy } from '../shared/access-token-policy'
import type { TokenPlan } from './access-token-auth'
import { getEnabledModelTargets } from './config/enabled-models'
import { listSurfaces } from './inbound-surface-service'
import { orderTokenProviders, tokenAllowsTarget } from './token-model-routing'

type ModelTarget = Awaited<ReturnType<typeof getEnabledModelTargets>>[number]

export async function tokenModelChoices(input: {
  surfaces?: readonly string[]
  plan?: Pick<TokenPlan, 'models'> | null
  policy?: TokenPolicy
}) {
  const surfaces = (await listSurfaces()).filter(
    (surface) => !input.surfaces?.length || input.surfaces.includes(surface.id)
  )
  const selections = await Promise.all(
    (['completion', 'image'] as const).map(async (operation) => {
      const scoped = surfaces.filter((surface) => surface.operation === operation)
      if (scoped.length === 0) return []
      const targets = await getEnabledModelTargets(undefined, operation)
      return targets.filter(
        (target) =>
          tokenAllowsTarget(input.plan, input.policy, target) &&
          scoped.some((surface) => !surface.deniedTargets.includes(`${target.provider},${target.model}`))
      )
    })
  )

  const grouped = new Map<string, ModelTarget[]>()
  for (const candidate of selections.flat()) {
    const candidates = grouped.get(candidate.model)
    if (candidates === undefined) grouped.set(candidate.model, [candidate])
    else candidates.push(candidate)
  }

  return Promise.all(
    [...grouped].map(async ([model, candidates]) => {
      const order = await orderTokenProviders(model, candidates, input.plan, input.policy)
      const chosen = order.status === 'preferred' ? order.providers[0] : null
      return { model, candidates, chosen }
    })
  )
}

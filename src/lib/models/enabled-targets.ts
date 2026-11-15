import type { Provider } from '@/schemas/domain/provider'

/** One "provider,model" the operator has left switched on. */
export interface EnabledTarget {
  target: string
  provider: string
  model: string
}

/**
 * Every "provider,model" the operator has left usable: providers switched
 * off and models in `transformer._disabledModels` drop out, matching the
 * gate the Providers screen applies. A plan's model list is chosen from
 * these.
 */
export function enabledTargets(providers: readonly Provider[]): EnabledTarget[] {
  const out: EnabledTarget[] = []
  for (const provider of providers) {
    if (provider.enabled === false) continue
    const disabled = new Set(provider.transformer?._disabledModels)
    for (const model of [...provider.models].sort((a, b) => a.localeCompare(b))) {
      if (disabled.has(model)) continue
      out.push({ target: `${provider.name},${model}`, provider: provider.name, model })
    }
  }
  return out
}

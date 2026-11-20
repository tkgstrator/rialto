import type { Provider } from '@/schemas/domain/provider'
import { isDeprecatedModel } from '@/shared/data'
import { AnthropicProvider } from '../vendors/anthropic'

const VERSIONED_MODEL = /^claude-(fable|haiku|mythos|opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/

export function latestAnthropicModels(models: readonly string[]): Set<string> {
  const latest = new Map<string, { id: string; generation: number; revision: number; release: number }>()
  for (const id of models) {
    const match = VERSIONED_MODEL.exec(id)
    if (!match || isDeprecatedModel(id)) continue
    const [, family, major, minor, date] = match
    const generation = Number(major)
    const revision = Number(minor || '0')
    // Prefer the stable alias when both spellings describe the same release.
    const release = date === undefined ? Infinity : Number(date)
    const current = latest.get(family)
    if (
      !current ||
      generation > current.generation ||
      (generation === current.generation &&
        (revision > current.revision || (revision === current.revision && release > current.release)))
    ) {
      latest.set(family, { id, generation, revision, release })
    }
  }
  return new Set([...latest.values()].map(({ id }) => id))
}

export async function discoverAnthropicApiKeyModels(provider: Provider): Promise<{
  provider: Provider
  warning?: string
}> {
  if (provider.api_key === null) return { provider }
  const result = await new AnthropicProvider()
    .fetchLiveModels(provider.api_key)
    .catch(() => ({ error: 'could not reach the Anthropic model list' }))
  const models = Array.isArray(result) ? [...new Set(result)] : provider.models
  const enabled = Array.isArray(result) ? latestAnthropicModels(models) : new Set<string>()

  return {
    provider: {
      ...provider,
      models,
      transformer: { ...provider.transformer, _disabledModels: models.filter((model) => !enabled.has(model)) }
    },
    ...(Array.isArray(result) ? {} : { warning: result.error })
  }
}

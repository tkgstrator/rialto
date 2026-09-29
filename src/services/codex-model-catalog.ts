import { z } from 'zod'
import packageInfo from '../../package.json'
import { logger } from '../logger'
import { isReasoningEffort, type ReasoningEffort } from '../shared/model-reasoning-effort'

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'

const CodexModelListSchema = z.object({
  models: z.array(
    z
      .object({
        slug: z.string().nonempty(),
        visibility: z.string().nonempty().optional(),
        // `context_window` is the default the Codex CLI starts from;
        // `max_context_window` is what the model serves once the window is
        // raised to its limit, and is the figure routing should trust.
        context_window: z.number().int().positive().optional(),
        max_context_window: z.number().int().positive().optional(),
        supported_reasoning_levels: z.array(z.object({ effort: z.string().nonempty() })).default([])
      })
      .passthrough()
  )
})

type CodexModelEntry = z.infer<typeof CodexModelListSchema>['models'][number]

/** What the Codex catalog says about one model that never changes for its id. */
export type CodexModelFacts = { id: string; contextWindow: number | null; efforts: ReasoningEffort[] }
export type CodexModelCatalog = { ids: string[]; models: CodexModelFacts[] }

const contextWindowOf = (model: CodexModelEntry): number | null => {
  if (model.max_context_window !== undefined) return model.max_context_window
  return model.context_window === undefined ? null : model.context_window
}

/** The Codex CLI reads this account-scoped catalog, not OpenAI's API price sheet. */
export async function fetchCodexModelCatalog(
  accessToken: string,
  accountId: string | null,
  fetchModels: typeof fetch = fetch
): Promise<CodexModelCatalog | null> {
  try {
    const url = new URL(CODEX_MODELS_URL)
    url.searchParams.set('client_version', packageInfo.version)
    const response = await fetchModels(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(accountId === null ? {} : { 'chatgpt-account-id': accountId })
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      logger.warn({ status: response.status }, '[codex-models] model catalog unavailable')
      await response.body?.cancel().catch(() => {})
      return null
    }
    const parsed = CodexModelListSchema.safeParse(await response.json())
    if (!parsed.success) {
      logger.warn('[codex-models] unexpected model catalog response')
      return null
    }
    const visible = parsed.data.models.filter((model) => model.visibility !== 'hide')
    const models = visible.map((model) => ({
      id: model.slug,
      contextWindow: contextWindowOf(model),
      // A level this build has no name for is dropped rather than guessed
      // at; it reappears once REASONING_EFFORTS learns it.
      efforts: [...new Set(model.supported_reasoning_levels.map((level) => level.effort).filter(isReasoningEffort))]
    }))
    return { ids: [...new Set(models.map((model) => model.id))], models }
  } catch {
    logger.warn('[codex-models] could not reach the model catalog')
    return null
  }
}

export async function fetchCodexModels(
  accessToken: string,
  accountId: string | null,
  fetchModels: typeof fetch = fetch
): Promise<string[] | null> {
  const catalog = await fetchCodexModelCatalog(accessToken, accountId, fetchModels)
  return catalog === null ? null : catalog.ids
}

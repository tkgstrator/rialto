import { z } from 'zod'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'

const CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json'

const ModelSchema = z.object({
  id: z.string().regex(/^claude-[a-z0-9-]+$/),
  offered_on: z.array(z.string().nonempty())
})

const CatalogSchema = z.object({
  schema_version: z.literal(1),
  surfaces: z.object({
    cc: z.object({
      model_selector_config: z.array(z.object({ id: z.string().nonempty(), models: z.array(ModelSchema) }))
    })
  })
})

const catalogModels = (payload: unknown): string[] | null => {
  const parsed = CatalogSchema.safeParse(payload)
  if (!parsed.success) return null
  const config = parsed.data.surfaces.cc.model_selector_config.find((entry) => entry.id === 'cc')
  if (config === undefined) return null
  return [
    ...new Set(config.models.filter((model) => model.offered_on.includes('first_party')).map((model) => model.id))
  ]
}

// The published CLI catalog lists candidates, not an account's entitlements.
// Never send OAuth credentials to this public endpoint.
export async function fetchClaudeCodeModels(fetchModels: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const response = await fetchModels(CATALOG_URL, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) {
      logger.warn({ status: response.status }, '[claude-code-models] model catalog unavailable')
      await response.body?.cancel().catch(() => {})
      return null
    }
    const models = catalogModels(await response.json())
    if (models === null || models.length === 0) {
      logger.warn('[claude-code-models] unexpected model catalog response')
      return null
    }
    return models
  } catch {
    logger.warn('[claude-code-models] could not reach the model catalog')
    return null
  }
}

// A failed refresh must not remove candidates already found in this process.
const discovered = new Set<string>()
export const claudeCodeModels = (): readonly string[] => [...discovered]

// How long a failed fetch keeps the lazy one below from trying again, so a
// vendor outage does not hold every catalog read behind a 10 s timeout.
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000
const fetchState: { pending: Promise<boolean> | null; failedAt: number | null } = { pending: null, failedAt: null }

export async function refreshClaudeCodeModels(fetchModels: typeof fetch = fetch): Promise<boolean> {
  const models = await fetchClaudeCodeModels(fetchModels)
  if (models === null) {
    fetchState.failedAt = dayjs().valueOf()
    return false
  }
  fetchState.failedAt = null
  for (const model of models) discovered.add(model)
  return true
}

/**
 * Fetch the catalog once if this process has none yet.
 *
 * No model list ships with Rialto, so a fresh process knows no Claude Code
 * model until the catalog is read; the first catalog view reads it rather
 * than showing an empty subscription. Concurrent callers share one fetch.
 */
export async function ensureClaudeCodeModels(fetchModels: typeof fetch = fetch): Promise<void> {
  if (discovered.size > 0) return
  if (fetchState.failedAt !== null && dayjs().valueOf() - fetchState.failedAt < RETRY_AFTER_FAILURE_MS) return
  const pending =
    fetchState.pending === null
      ? refreshClaudeCodeModels(fetchModels).finally(() => {
          fetchState.pending = null
        })
      : fetchState.pending
  fetchState.pending = pending
  await pending
}

export function __resetClaudeCodeModelsForTests(): void {
  discovered.clear()
  fetchState.pending = null
  fetchState.failedAt = null
}

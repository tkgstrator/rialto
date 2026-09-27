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
        supported_reasoning_levels: z.array(z.object({ effort: z.string().nonempty() })).default([])
      })
      .passthrough()
  )
})

type CodexModelCatalog = { ids: string[]; efforts: Map<string, readonly ReasoningEffort[]> }
const byAccount = new Map<string, Map<string, readonly ReasoningEffort[]>>()
const lastSuccess = new Map<string, number>()
const pending = new Map<string, Promise<CodexModelCatalog | null>>()
const lastAttempt = new Map<string, number>()
const RETRY_MS = 5 * 60_000

export const codexEffortsFor = (subAccountId: string, model: string): readonly ReasoningEffort[] | null => {
  const updated = lastSuccess.get(subAccountId)
  if (updated === undefined || Date.now() - updated > RETRY_MS) return null
  const found = byAccount.get(subAccountId)?.get(model)
  return found === undefined ? null : found
}

function saveCapabilities(subAccountId: string | undefined, catalog: CodexModelCatalog): void {
  if (subAccountId !== undefined) {
    byAccount.set(subAccountId, catalog.efforts)
    lastSuccess.set(subAccountId, Date.now())
  }
}

/** The Codex CLI reads this account-scoped catalog, not OpenAI's API price sheet. */
export async function fetchCodexModelCatalog(
  accessToken: string,
  accountId: string | null,
  fetchModels: typeof fetch = fetch,
  subAccountId?: string
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
    const efforts = new Map<string, readonly ReasoningEffort[]>()
    for (const model of visible) {
      if (model.supported_reasoning_levels.length === 0) continue
      const known = [
        ...new Set(model.supported_reasoning_levels.map((level) => level.effort).filter(isReasoningEffort))
      ]
      if (known.length > 0) efforts.set(model.slug, known)
    }
    const catalog = { ids: [...new Set(visible.map((model) => model.slug))], efforts }
    saveCapabilities(subAccountId, catalog)
    if (subAccountId !== undefined) lastAttempt.set(subAccountId, Date.now())
    return catalog
  } catch {
    logger.warn('[codex-models] could not reach the model catalog')
    return null
  }
}

export async function fetchCodexModels(
  accessToken: string,
  accountId: string | null,
  fetchModels: typeof fetch = fetch,
  subAccountId?: string
): Promise<string[] | null> {
  const catalog = await fetchCodexModelCatalog(accessToken, accountId, fetchModels, subAccountId)
  return catalog === null ? null : catalog.ids
}

export async function ensureCodexEfforts(
  subAccountId: string,
  accessToken: string,
  accountId: string | null
): Promise<void> {
  const updated = lastSuccess.get(subAccountId)
  if (updated !== undefined && Date.now() - updated < RETRY_MS) return
  const running = pending.get(subAccountId)
  if (running !== undefined) {
    await running
    return
  }
  const attempted = lastAttempt.get(subAccountId)
  if (attempted !== undefined && Date.now() - attempted < RETRY_MS) return
  lastAttempt.set(subAccountId, Date.now())
  const request = fetchCodexModelCatalog(accessToken, accountId, fetch, subAccountId)
  pending.set(subAccountId, request)
  try {
    await request
  } finally {
    pending.delete(subAccountId)
  }
}

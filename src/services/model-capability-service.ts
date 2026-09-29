/**
 * What a subscription model accepts, read once.
 *
 * A model id is a pinned snapshot, so its context window, the effort
 * levels it takes and the `thinking` settings it accepts never change.
 * Only its price and whether it is listed at all do, and those stay on the
 * refresh. Re-reading the rest on every refresh bought nothing and let a
 * scrape of a vendor's *API* docs overwrite what the subscription itself
 * serves (Codex publishes its own window; OpenAI's docs describe the
 * API's), so each fact is read from the subscription's own model list the
 * first time a row lacks it and never again.
 *
 * Two stages, because they cost differently:
 * - the model list (context window, efforts): one call answers for every
 *   model, so every listed model is recorded;
 * - Claude's thinking-off probe: a dozen count_tokens calls per model, so
 *   only switched-on models, the ones a request can reach.
 */

import { z } from 'zod'
import { getPrismaClient } from '../db/client'
import { AuthMode, type PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { resetLlmsContext } from '../llms'
import { logger } from '../logger'
import { SupportedEffortSchema } from '../schemas/domain/model-capability'
import { isReasoningEffort, type ReasoningEffort } from '../shared/model-reasoning-effort'
import { probeThinkingOff } from './claude-thinking-probe'
import { fetchCodexModelCatalog } from './codex-model-catalog'
import { getUsableSubAccountAuth } from './subscription-account-sync/read'

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'

type SubscriptionKind = 'claude-code' | 'codex'
type ListedModel = { id: string; contextWindow: number | null; efforts: ReasoningEffort[] }

const CapabilitySupportSchema = z.object({ supported: z.boolean() })
const AnthropicModelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().nonempty(),
      max_input_tokens: z.number().int().positive().nullable().optional(),
      // One `{supported}` per level, beside a `supported` flag for effort
      // as a whole; read per level so a level added later is simply absent.
      capabilities: z
        .object({ effort: z.record(z.string().nonempty(), z.unknown()) })
        .nullable()
        .optional()
    })
  )
})

const effortsFrom = (effort: Record<string, unknown> | undefined): ReasoningEffort[] =>
  effort === undefined
    ? []
    : SupportedEffortSchema.options.filter((level) => {
        const parsed = CapabilitySupportSchema.safeParse(effort[level])
        return parsed.success && parsed.data.supported
      })

async function listClaudeModels(accessToken: string, fetchImpl: typeof fetch): Promise<ListedModel[] | null> {
  try {
    const response = await fetchImpl(ANTHROPIC_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      logger.warn({ status: response.status }, '[model-capability] Claude model list unavailable')
      await response.body?.cancel().catch(() => {})
      return null
    }
    const parsed = AnthropicModelListSchema.safeParse(await response.json())
    if (!parsed.success) {
      logger.warn('[model-capability] unexpected Claude model list response')
      return null
    }
    return parsed.data.data.map((model) => ({
      id: model.id,
      contextWindow: model.max_input_tokens === undefined ? null : model.max_input_tokens,
      efforts: effortsFrom(
        model.capabilities === undefined || model.capabilities === null ? undefined : model.capabilities.effort
      )
    }))
  } catch {
    logger.warn('[model-capability] could not reach the Claude model list')
    return null
  }
}

async function listModels(
  kind: SubscriptionKind,
  fetchImpl: typeof fetch,
  prisma: PrismaClient
): Promise<ListedModel[] | null> {
  const auth = await getUsableSubAccountAuth(kind, prisma)
  if (auth === null || auth.accessToken === null) return null
  if (kind === 'claude-code') return listClaudeModels(auth.accessToken, fetchImpl)
  const catalog = await fetchCodexModelCatalog(auth.accessToken, auth.accountId, fetchImpl)
  return catalog === null ? null : catalog.models
}

// Record the list facts for every row of `kind` that has none yet. A row
// the list does not describe stays unrecorded and is asked about again
// next time, rather than being marked as knowing nothing.
async function recordListed(kind: SubscriptionKind, fetchImpl: typeof fetch, prisma: PrismaClient): Promise<string[]> {
  const missing = await prisma.model.findMany({
    where: { capability: null, provider: { name: kind, authMode: AuthMode.subscription } },
    select: { id: true, name: true }
  })
  if (missing.length === 0) return []
  const listed = await listModels(kind, fetchImpl, prisma)
  if (listed === null) return []
  const byId = new Map(listed.map((model) => [model.id, model]))
  const recorded: string[] = []
  for (const row of missing) {
    const facts = byId.get(row.name)
    if (facts === undefined) continue
    await prisma.$transaction([
      prisma.modelCapability.upsert({
        where: { modelId: row.id },
        create: { modelId: row.id, efforts: facts.efforts },
        update: {}
      }),
      ...(facts.contextWindow === null
        ? []
        : [prisma.model.update({ where: { id: row.id }, data: { contextWindow: facts.contextWindow } })])
    ])
    recorded.push(row.name)
  }
  return recorded
}

async function probeSwitchedOnClaudeModels(fetchImpl: typeof fetch, prisma: PrismaClient): Promise<string[]> {
  const pending = await prisma.modelCapability.findMany({
    where: {
      thinkingProbedAt: null,
      model: { enabled: true, provider: { name: 'claude-code', authMode: AuthMode.subscription } }
    },
    select: { modelId: true, efforts: true, model: { select: { name: true } } }
  })
  if (pending.length === 0) return []
  const auth = await getUsableSubAccountAuth('claude-code', prisma)
  if (auth === null || auth.accessToken === null) return []
  const probed: string[] = []
  for (const row of pending) {
    const support = await probeThinkingOff(
      row.model.name,
      row.efforts.filter(isReasoningEffort),
      auth.accessToken,
      fetchImpl
    )
    if (support === null) {
      logger.warn({ model: row.model.name }, '[model-capability] thinking probe inconclusive; retried on the next pass')
      continue
    }
    await prisma.modelCapability.update({
      where: { modelId: row.modelId },
      data: {
        thinkingProbedAt: dayjs().toDate(),
        thinkingDisabled: support.disabled,
        thinkingBetweenTools: support.betweenTools
      }
    })
    probed.push(row.model.name)
  }
  return probed
}

async function captureAll(fetchImpl: typeof fetch, prisma: PrismaClient): Promise<void> {
  const listed = [
    ...(await recordListed('claude-code', fetchImpl, prisma)),
    ...(await recordListed('codex', fetchImpl, prisma))
  ]
  const probed = await probeSwitchedOnClaudeModels(fetchImpl, prisma)
  if (listed.length === 0 && probed.length === 0) return
  logger.info({ listed, probed }, '[model-capability] recorded model capabilities')
  // The pipeline reads these through the cached provider registry.
  resetLlmsContext()
}

// One pass at a time: a toggle landing mid-refresh queues behind it rather
// than probing the same model twice.
const queue: { tail: Promise<void> } = { tail: Promise.resolve() }

/**
 * Record whatever is still unknown about the subscription models: list
 * facts for every row, the thinking probe for switched-on Claude Code
 * rows. Cheap when nothing is missing (two indexed queries), so every
 * path that switches a model on calls it. Never throws.
 */
export function captureModelCapabilities(
  fetchImpl: typeof fetch = fetch,
  prisma: PrismaClient = getPrismaClient()
): Promise<void> {
  const run = queue.tail
    .then(() => captureAll(fetchImpl, prisma))
    .catch((err: unknown) => {
      logger.warn({ err }, '[model-capability] capture failed')
    })
  queue.tail = run
  return run
}

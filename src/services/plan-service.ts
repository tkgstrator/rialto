/**
 * Plans: what a token on one may spend.
 *
 * A plan is referenced by its tokens, never copied onto them, so an edit
 * here reaches every token on it at its next request — which is why every
 * write clears the token resolver cache, where the plan is read from.
 */

import { getPrismaClient } from '../db/client'
import { invalidateTokenCache } from './access-token-service'

export interface PlanRow {
  id: string
  name: string
  /** `provider,model` ids a request may name. */
  models: string[]
  /** Always one of `models`. */
  defaultModel: string
  /** Completions per UTC day. Null = no cap. */
  dailyRequestLimit: number | null
  /** Tokens on this plan, hand-issued and app-minted alike. */
  tokenCount: number
  /** Apps whose new installs start on this plan. */
  apps: { id: string; name: string }[]
  createdAt: string
  updatedAt: string
}

export interface PlanInput {
  name: string
  models: string[]
  defaultModel: string
  dailyRequestLimit: number | null
}

export type PlanRefusal = 'invalid' | 'duplicate-name' | 'not-found' | 'in-use'

export type PlanResult = { ok: true; plan: PlanRow } | { ok: false; reason: PlanRefusal; message: string }

const INCLUDE = {
  _count: { select: { tokens: true } },
  apps: { select: { id: true, name: true }, orderBy: { name: 'asc' } }
} as const

type PlanRecord = {
  id: string
  name: string
  models: string[]
  defaultModel: string
  dailyRequestLimit: number | null
  createdAt: Date
  updatedAt: Date
  _count: { tokens: number }
  apps: { id: string; name: string }[]
}

const toRow = (row: PlanRecord): PlanRow => ({
  id: row.id,
  name: row.name,
  models: row.models,
  defaultModel: row.defaultModel,
  dailyRequestLimit: row.dailyRequestLimit,
  tokenCount: row._count.tokens,
  apps: row.apps,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString()
})

/**
 * Why a plan cannot be saved as given, or null. The default has to be one
 * of the allowed models: a default outside the list would send the
 * requests the list exists to catch somewhere it does not allow.
 */
export function planProblem(input: PlanInput): string | null {
  if (input.name.trim().length === 0) return 'A plan needs a name.'
  if (input.models.length === 0) return 'A plan needs at least one model.'
  if (new Set(input.models).size !== input.models.length) return 'A model is listed twice.'
  if (!input.models.includes(input.defaultModel)) return 'The default model has to be one of the allowed models.'
  if (
    input.dailyRequestLimit !== null &&
    (!Number.isSafeInteger(input.dailyRequestLimit) || input.dailyRequestLimit < 1)
  ) {
    return 'The daily cap has to be a whole number above zero, or empty for no cap.'
  }
  return null
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002'

export async function listPlans(): Promise<PlanRow[]> {
  const rows = await getPrismaClient().plan.findMany({ orderBy: { createdAt: 'asc' }, include: INCLUDE })
  return rows.map(toRow)
}

export async function getPlan(id: string): Promise<PlanRow | null> {
  const row = await getPrismaClient()
    .plan.findUnique({ where: { id }, include: INCLUDE })
    .catch(() => null)
  return row === null ? null : toRow(row)
}

export async function createPlan(input: PlanInput): Promise<PlanResult> {
  const problem = planProblem(input)
  if (problem !== null) return { ok: false, reason: 'invalid', message: problem }
  try {
    const row = await getPrismaClient().plan.create({
      data: {
        name: input.name.trim(),
        models: input.models,
        defaultModel: input.defaultModel,
        dailyRequestLimit: input.dailyRequestLimit
      },
      include: INCLUDE
    })
    return { ok: true, plan: toRow(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate-name', message: 'A plan with that name exists.' }
    throw err
  }
}

/** Merge a partial edit onto the stored plan, validate the result as a whole, save it. */
export async function updatePlan(id: string, patch: Partial<PlanInput>): Promise<PlanResult> {
  const prisma = getPrismaClient()
  const current = await prisma.plan.findUnique({ where: { id } }).catch(() => null)
  if (current === null) return { ok: false, reason: 'not-found', message: 'No such plan.' }
  const next: PlanInput = {
    name: patch.name === undefined ? current.name : patch.name,
    models: patch.models === undefined ? current.models : patch.models,
    defaultModel: patch.defaultModel === undefined ? current.defaultModel : patch.defaultModel,
    dailyRequestLimit: patch.dailyRequestLimit === undefined ? current.dailyRequestLimit : patch.dailyRequestLimit
  }
  const problem = planProblem(next)
  if (problem !== null) return { ok: false, reason: 'invalid', message: problem }
  try {
    const row = await prisma.plan.update({
      where: { id },
      data: { ...next, name: next.name.trim() },
      include: INCLUDE
    })
    // Tokens read their plan through the resolver cache; without this a
    // lowered cap would keep admitting for up to its TTL.
    invalidateTokenCache()
    return { ok: true, plan: toRow(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate-name', message: 'A plan with that name exists.' }
    throw err
  }
}

/**
 * Delete a plan nothing uses. A plan with tokens or apps on it is refused
 * rather than cascaded: removing it would silently lift those tokens' caps.
 */
export async function deletePlan(
  id: string
): Promise<{ ok: true } | { ok: false; reason: PlanRefusal; message: string }> {
  const plan = await getPlan(id)
  if (plan === null) return { ok: false, reason: 'not-found', message: 'No such plan.' }
  if (plan.tokenCount > 0 || plan.apps.length > 0) {
    return { ok: false, reason: 'in-use', message: 'Move its tokens and apps to another plan first.' }
  }
  await getPrismaClient().plan.delete({ where: { id } })
  return { ok: true }
}

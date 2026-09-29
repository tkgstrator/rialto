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
  /** Completions admitted per 5-hour window. Null = no limit. */
  fiveHourRequestLimit: number | null
  /** USD spent per 5-hour window. Null = no limit. */
  fiveHourSpendLimitUsd: number | null
  /** Completions admitted per 7-day window. Null = no limit. */
  sevenDayRequestLimit: number | null
  /** USD spent per 7-day window. Null = no limit. */
  sevenDaySpendLimitUsd: number | null
  /** Tokens on this plan. */
  tokenCount: number
  createdAt: string
  updatedAt: string
}

export interface PlanInput {
  name: string
  models: string[]
  defaultModel: string
  fiveHourRequestLimit: number | null
  fiveHourSpendLimitUsd: number | null
  sevenDayRequestLimit: number | null
  sevenDaySpendLimitUsd: number | null
}

export type PlanRefusal = 'invalid' | 'duplicate-name' | 'not-found' | 'in-use'

export type PlanResult = { ok: true; plan: PlanRow } | { ok: false; reason: PlanRefusal; message: string }

const INCLUDE = {
  _count: { select: { tokens: true } }
} as const

type PlanRecord = {
  id: string
  name: string
  models: string[]
  defaultModel: string
  fiveHourRequestLimit: number | null
  fiveHourSpendLimitUsd: number | null
  sevenDayRequestLimit: number | null
  sevenDaySpendLimitUsd: number | null
  createdAt: Date
  updatedAt: Date
  _count: { tokens: number }
}

const toRow = (row: PlanRecord): PlanRow => ({
  id: row.id,
  name: row.name,
  models: row.models,
  defaultModel: row.defaultModel,
  fiveHourRequestLimit: row.fiveHourRequestLimit,
  fiveHourSpendLimitUsd: row.fiveHourSpendLimitUsd,
  sevenDayRequestLimit: row.sevenDayRequestLimit,
  sevenDaySpendLimitUsd: row.sevenDaySpendLimitUsd,
  tokenCount: row._count.tokens,
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
  for (const limit of [input.fiveHourRequestLimit, input.sevenDayRequestLimit]) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
      return 'A request limit has to be a whole number above zero, or empty for no limit.'
    }
  }
  for (const limit of [input.fiveHourSpendLimitUsd, input.sevenDaySpendLimitUsd]) {
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
      return 'A spend limit has to be an amount above zero, or empty for no limit.'
    }
  }
  return null
}

/** The four limit columns of a plan input, for Prisma writes. */
const limitsOf = (input: PlanInput) => ({
  fiveHourRequestLimit: input.fiveHourRequestLimit,
  fiveHourSpendLimitUsd: input.fiveHourSpendLimitUsd,
  sevenDayRequestLimit: input.sevenDayRequestLimit,
  sevenDaySpendLimitUsd: input.sevenDaySpendLimitUsd
})

/** A patched field, or the stored one when the patch leaves it out. */
const patched = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value)

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
        ...limitsOf(input)
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
    name: patched(patch.name, current.name),
    models: patched(patch.models, current.models),
    defaultModel: patched(patch.defaultModel, current.defaultModel),
    fiveHourRequestLimit: patched(patch.fiveHourRequestLimit, current.fiveHourRequestLimit),
    fiveHourSpendLimitUsd: patched(patch.fiveHourSpendLimitUsd, current.fiveHourSpendLimitUsd),
    sevenDayRequestLimit: patched(patch.sevenDayRequestLimit, current.sevenDayRequestLimit),
    sevenDaySpendLimitUsd: patched(patch.sevenDaySpendLimitUsd, current.sevenDaySpendLimitUsd)
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
    // lowered limit would keep admitting for up to its TTL.
    invalidateTokenCache()
    return { ok: true, plan: toRow(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate-name', message: 'A plan with that name exists.' }
    throw err
  }
}

/**
 * Delete a plan nothing uses. A plan with tokens on it is refused
 * rather than cascaded: removing it would silently lift those tokens' limits.
 */
export async function deletePlan(
  id: string
): Promise<{ ok: true } | { ok: false; reason: PlanRefusal; message: string }> {
  const plan = await getPlan(id)
  if (plan === null) return { ok: false, reason: 'not-found', message: 'No such plan.' }
  if (plan.tokenCount > 0) {
    return { ok: false, reason: 'in-use', message: 'Move its tokens to another plan first.' }
  }
  await getPrismaClient().plan.delete({ where: { id } })
  return { ok: true }
}

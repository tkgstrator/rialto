/**
 * Pure logic behind the Plans tab and its edit dialog.
 *
 * The dialog picks a provider first and then that provider's models,
 * because an install can carry dozens of models across a handful of
 * providers and one flat list of them is a scroll hunt. Everything here
 * works on the `provider,model` ids the server stores, so what the dialog
 * saves is exactly what the gate compares requests against.
 */

import type { PlanInputWire } from '@/lib/api-types'

/** The part of `provider,model` before the first comma. */
export const providerOf = (target: string): string => {
  const comma = target.indexOf(',')
  return comma === -1 ? target : target.slice(0, comma)
}

/** The part of `provider,model` after the first comma. */
export const modelOf = (target: string): string => {
  const comma = target.indexOf(',')
  return comma === -1 ? target : target.slice(comma + 1)
}

export interface ProviderGroup {
  provider: string
  /** Full `provider,model` ids, in the order the dialog lists them. */
  targets: string[]
}

/**
 * The provider chips and the models under each.
 *
 * `available` is what the operator has left routable; `selected` is what
 * the plan already allows. A selected model that is no longer available
 * — its provider was switched off, or the model was — is still listed, so
 * it can be seen and unticked rather than lingering on the plan invisibly.
 */
export function groupTargets(available: readonly string[], selected: readonly string[]): ProviderGroup[] {
  const groups = new Map<string, string[]>()
  for (const target of [...available, ...selected]) {
    const provider = providerOf(target)
    const targets = groups.get(provider)
    if (targets === undefined) groups.set(provider, [target])
    else if (!targets.includes(target)) targets.push(target)
  }
  return [...groups.entries()].map(([provider, targets]) => ({ provider, targets }))
}

/** The plan's four usage-window limits, by their wire names. */
export const LIMIT_FIELDS = [
  'fiveHourRequestLimit',
  'fiveHourSpendLimitUsd',
  'sevenDayRequestLimit',
  'sevenDaySpendLimitUsd'
] as const

export type LimitField = (typeof LIMIT_FIELDS)[number]

/** Whether a limit counts requests (a whole number) or USD (an amount). */
export const isSpendField = (field: LimitField): boolean => field.endsWith('SpendLimitUsd')

export interface PlanDraft {
  name: string
  models: string[]
  /** Empty while no model is ticked. */
  defaultModel: string
  /** Each limit field's text. Empty means no limit. */
  limits: Record<LimitField, string>
}

const emptyLimits = (): Record<LimitField, string> => ({
  fiveHourRequestLimit: '',
  fiveHourSpendLimitUsd: '',
  sevenDayRequestLimit: '',
  sevenDaySpendLimitUsd: ''
})

export const emptyPlanDraft = (): PlanDraft => ({ name: '', models: [], defaultModel: '', limits: emptyLimits() })

const limitText = (value: number | null): string => (value === null ? '' : String(value))

export const planDraftOf = (plan: PlanInputWire): PlanDraft => ({
  name: plan.name,
  models: [...plan.models],
  defaultModel: plan.defaultModel,
  limits: {
    fiveHourRequestLimit: limitText(plan.fiveHourRequestLimit),
    fiveHourSpendLimitUsd: limitText(plan.fiveHourSpendLimitUsd),
    sevenDayRequestLimit: limitText(plan.sevenDayRequestLimit),
    sevenDaySpendLimitUsd: limitText(plan.sevenDaySpendLimitUsd)
  }
})

/**
 * Tick or untick a model, keeping the default one of the ticked ones.
 *
 * The first model ticked becomes the default, and unticking the default
 * hands it to the first model left: a plan saved with a default outside
 * its list is refused by the server, so the dialog never offers one.
 */
export function toggleModel(draft: PlanDraft, target: string): PlanDraft {
  if (draft.models.includes(target)) {
    const models = draft.models.filter((m) => m !== target)
    const defaultModel = draft.defaultModel === target ? (models.length === 0 ? '' : models[0]) : draft.defaultModel
    return { ...draft, models, defaultModel }
  }
  const models = [...draft.models, target]
  return { ...draft, models, defaultModel: draft.defaultModel === '' ? target : draft.defaultModel }
}

export type LimitReading = { ok: true; value: number | null } | { ok: false }

/** A request limit's text as the wire's value: empty is no limit, anything else a whole number above zero. */
export function readCap(text: string): LimitReading {
  const trimmed = text.trim().replaceAll(',', '')
  if (trimmed.length === 0) return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? { ok: true, value } : { ok: false }
}

/** A spend limit's text as USD: empty is no limit, anything else an amount above zero ("$" allowed). */
export function readSpend(text: string): LimitReading {
  const trimmed = text.trim().replaceAll(',', '').replace(/^\$/, '')
  if (trimmed.length === 0) return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isFinite(value) && value > 0 ? { ok: true, value } : { ok: false }
}

/** One limit field's text, read the way its kind requires. */
export const readLimit = (field: LimitField, text: string): LimitReading =>
  isSpendField(field) ? readSpend(text) : readCap(text)

/**
 * The draft as the body to send, or null while it could not be saved.
 * Mirrors the server's own check so Save is disabled rather than
 * answered with a 400.
 */
export function planInputOf(draft: PlanDraft): PlanInputWire | null {
  const read = LIMIT_FIELDS.map((field) => readLimit(field, draft.limits[field]))
  const values = read.flatMap((reading) => (reading.ok ? [reading.value] : []))
  if (values.length !== LIMIT_FIELDS.length) return null
  if (draft.name.trim().length === 0) return null
  if (draft.models.length === 0 || !draft.models.includes(draft.defaultModel)) return null
  return {
    name: draft.name.trim(),
    models: draft.models,
    defaultModel: draft.defaultModel,
    fiveHourRequestLimit: values[0],
    fiveHourSpendLimitUsd: values[1],
    sevenDayRequestLimit: values[2],
    sevenDaySpendLimitUsd: values[3]
  }
}

/** Whether saving the draft would change the plan. */
export function planDraftChanged(draft: PlanDraft, plan: PlanInputWire): boolean {
  const input = planInputOf(draft)
  if (input === null) return true
  return (
    input.name !== plan.name ||
    input.defaultModel !== plan.defaultModel ||
    LIMIT_FIELDS.some((field) => input[field] !== plan[field]) ||
    input.models.length !== plan.models.length ||
    input.models.some((m) => !plan.models.includes(m))
  )
}

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

export interface PlanDraft {
  name: string
  models: string[]
  /** Empty while no model is ticked. */
  defaultModel: string
  /** The field's text. Empty means no cap. */
  cap: string
}

export const emptyPlanDraft = (): PlanDraft => ({ name: '', models: [], defaultModel: '', cap: '' })

export const planDraftOf = (plan: {
  name: string
  models: string[]
  defaultModel: string
  dailyRequestLimit: number | null
}): PlanDraft => ({
  name: plan.name,
  models: [...plan.models],
  defaultModel: plan.defaultModel,
  cap: plan.dailyRequestLimit === null ? '' : String(plan.dailyRequestLimit)
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

export type CapReading = { ok: true; value: number | null } | { ok: false }

/** The cap field's text as the wire's value: empty is no cap, anything else a whole number above zero. */
export function readCap(text: string): CapReading {
  const trimmed = text.trim().replaceAll(',', '')
  if (trimmed.length === 0) return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? { ok: true, value } : { ok: false }
}

/**
 * The draft as the body to send, or null while it could not be saved.
 * Mirrors the server's own check so Save is disabled rather than
 * answered with a 400.
 */
export function planInputOf(draft: PlanDraft): PlanInputWire | null {
  const cap = readCap(draft.cap)
  if (!cap.ok) return null
  if (draft.name.trim().length === 0) return null
  if (draft.models.length === 0 || !draft.models.includes(draft.defaultModel)) return null
  return {
    name: draft.name.trim(),
    models: draft.models,
    defaultModel: draft.defaultModel,
    dailyRequestLimit: cap.value
  }
}

/** Whether saving the draft would change the plan. */
export function planDraftChanged(draft: PlanDraft, plan: PlanInputWire): boolean {
  const input = planInputOf(draft)
  if (input === null) return true
  return (
    input.name !== plan.name ||
    input.defaultModel !== plan.defaultModel ||
    input.dailyRequestLimit !== plan.dailyRequestLimit ||
    input.models.length !== plan.models.length ||
    input.models.some((m) => !plan.models.includes(m))
  )
}

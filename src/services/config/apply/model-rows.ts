/**
 * Reconcile a Provider's Model rows against the UI's `models` list:
 * create/delete rows, resync the deprecated flag, and flip
 * Model.enabled from the transformer's `_disabledModels` selection.
 */

import type { Provider } from '@/schemas/domain/provider'
import { isDeprecatedModel } from '@/shared/data'
import {
  type ApiStyle,
  AuthMode,
  type Model as DbModel,
  type Provider as DbProvider,
  ModelTestStatus
} from '../../../generated/prisma/client'
import { modelApiStyleOverride } from '../api-style'
import type { Tx } from '../apply'
import { disabledSet } from '../transformer'
import { tierCascadeWarning } from './tier-route-cascade'

export async function syncDeprecationFlags(tx: Tx, providerId: string, names: string[]): Promise<void> {
  if (names.length === 0) return
  const deprecated = names.filter(isDeprecatedModel)
  const active = names.filter((n) => !isDeprecatedModel(n))
  if (deprecated.length > 0) {
    await tx.model.updateMany({
      where: { providerId, name: { in: deprecated }, deprecated: false },
      data: { deprecated: true }
    })
  }
  if (active.length > 0) {
    await tx.model.updateMany({
      where: { providerId, name: { in: active }, deprecated: true },
      data: { deprecated: false }
    })
  }
}

// Reconcile the Model rows for a provider against the UI's `models` list:
// create the missing ones, delete the removed ones (warning about the
// tier aliases they unset), and resync the deprecated
// flag on the rows we kept.
export async function reconcileModelRows(
  tx: Tx,
  provider: DbProvider & { models: DbModel[] },
  incoming: Provider,
  warnings: string[]
): Promise<void> {
  const desired = new Set(incoming.models)
  const existingNames = new Set(provider.models.map((m) => m.name))
  const toDelete = [...existingNames].filter((n) => !desired.has(n))
  const toCreate = [...desired].filter((n) => !existingNames.has(n))

  if (toDelete.length > 0) {
    const cascade = await tierCascadeWarning(
      tx,
      provider.id,
      toDelete,
      `"${provider.name}" model(s) removed in this save (${toDelete.join(', ')})`
    )
    if (cascade !== null) warnings.push(cascade)
    await tx.model.deleteMany({
      where: { providerId: provider.id, name: { in: toDelete } }
    })
  }
  if (toCreate.length > 0) {
    await tx.model.createMany({
      // enabled omitted -> DB default (false). The authoritative
      // enabled state is written just below from the UI's selection.
      data: toCreate.map((name) => ({
        providerId: provider.id,
        name,
        deprecated: isDeprecatedModel(name),
        apiStyle: modelApiStyleOverride(name)
      }))
    })
  }

  // Resync the deprecation flag on rows we kept — the registry may
  // have flipped a model between releases, and we don't want a model
  // first seeded as active to silently stay that way.
  await syncDeprecationFlags(
    tx,
    provider.id,
    [...desired].filter((n) => existingNames.has(n))
  )
}

// Write the per-model apiStyle override (Model.apiStyle) from the payload's
// `modelApiStyles`: which wire format one model of an api_key provider is
// sent in. One OpenAI provider can serve a model over Chat Completions or
// over Responses, and the operator chooses per model.
//
// The field being present is what makes the map authoritative. A payload
// that carries it is the operator's whole view of the overrides, so a model
// it does not list is lifted back to the provider's own style. A payload
// without it — the connect flow, a config import, any caller that never read
// the overrides — says nothing about them, and every stored value stays.
//
// Rows created in this same save are the exception to "unlisted means
// lifted". Creation seeds the name-derived default (`modelApiStyleOverride`:
// codex-family is Responses-only), and a payload that has never seen the row
// could not have meant to cancel it; listing the model is how it does.
//
// A style equal to the provider's is stored as null: the override would add
// nothing (`modelTransformerChains` skips it), and null is what keeps the
// model following the provider if that ever changes.
//
// Subscription providers are left alone. Their chain ends in an auth step
// and their rows all carry the vendor's one style, so there is nothing to
// choose — the field comes back on every read and a round trip must not
// disturb it.
export async function applyModelApiStyles(
  tx: Tx,
  provider: DbProvider & { models: DbModel[] },
  incoming: Provider,
  warnings: string[]
): Promise<void> {
  const requested = incoming.modelApiStyles
  if (requested === undefined) return
  if (provider.authMode === AuthMode.subscription) return

  const desired = new Set(incoming.models)
  const existing = new Set(provider.models.map((m) => m.name))
  // A name with no row to write to is most likely a typo or a stale client.
  const strays = Object.keys(requested).filter((name) => !desired.has(name))
  if (strays.length > 0) {
    warnings.push(
      `modelApiStyles names model(s) that are not in "${provider.name}" models, ignored: ${strays.join(', ')}`
    )
  }

  const targets = [...desired].flatMap((name): [string, ApiStyle | null][] => {
    if (Object.hasOwn(requested, name)) {
      const style = requested[name]
      return [[name, style === provider.apiStyle ? null : style]]
    }
    return existing.has(name) ? [[name, null]] : []
  })

  const namesByStyle = new Map<ApiStyle | null, string[]>()
  for (const [name, style] of targets) {
    const names = namesByStyle.get(style)
    namesByStyle.set(style, names === undefined ? [name] : [...names, name])
  }

  // Only rows whose value actually changes are written, and their last test
  // is cleared: a result recorded against the other endpoint says nothing
  // about this one.
  for (const [style, names] of namesByStyle) {
    await tx.model.updateMany({
      where: {
        providerId: provider.id,
        name: { in: names },
        ...(style === null ? { apiStyle: { not: null } } : { OR: [{ apiStyle: null }, { apiStyle: { not: style } }] })
      },
      data: {
        apiStyle: style,
        testStatus: ModelTestStatus.unknown,
        testCheckedAt: null,
        testPassedAt: null,
        testError: null
      }
    })
  }
}

// Flip Model.enabled based on the UI's _disabledModels selection and
// reset persisted test status for any row whose enabled state actually
// changed (a re-enabled model shouldn't show a stale pass/fail; a
// disabled one shouldn't keep a result).
export async function applyModelEnabledFlips(
  tx: Tx,
  provider: DbProvider,
  incoming: Provider,
  prevEnabledByName: Map<string, boolean>
): Promise<void> {
  const nextDisabled = disabledSet(incoming.transformer)
  const desiredNames = [...new Set(incoming.models)]
  const toEnable = desiredNames.filter((n) => !nextDisabled.has(n))
  const toDisable = desiredNames.filter((n) => nextDisabled.has(n))
  const flipped = desiredNames.filter((n) => {
    const prev = prevEnabledByName.get(n)
    return prev !== undefined && prev !== !nextDisabled.has(n)
  })
  if (toEnable.length > 0) {
    await tx.model.updateMany({
      where: { providerId: provider.id, name: { in: toEnable }, enabled: false },
      data: { enabled: true }
    })
  }
  if (toDisable.length > 0) {
    await tx.model.updateMany({
      where: { providerId: provider.id, name: { in: toDisable }, enabled: true },
      data: { enabled: false }
    })
  }
  if (flipped.length > 0) {
    await tx.model.updateMany({
      where: { providerId: provider.id, name: { in: flipped } },
      data: {
        testStatus: ModelTestStatus.unknown,
        testCheckedAt: null,
        testPassedAt: null,
        testError: null
      }
    })
  }
}

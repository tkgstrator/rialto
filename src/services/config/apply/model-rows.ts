/**
 * Reconcile a Provider's Model rows against the UI's `models` list:
 * create/delete rows, resync the deprecated flag, and flip
 * Model.enabled from the transformer's `_disabledModels` selection.
 */

import type { Provider } from '@/schemas/domain/provider'
import { isDeprecatedModel } from '@/shared/data'
import { type Model as DbModel, type Provider as DbProvider, ModelTestStatus } from '../../../generated/prisma/client'
import { modelApiStyleOverride } from '../api-style'
import type { Tx } from '../apply'
import { disabledSet } from '../transformer'
import { chainEntryCascadeWarning } from './chain-entries'

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
// chain entries that cascade away with them), and resync the deprecated
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
    const cascade = await chainEntryCascadeWarning(
      tx,
      { providerId: provider.id, name: { in: toDelete } },
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

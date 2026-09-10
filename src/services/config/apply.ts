/**
 * Write-side application: diff an incoming UI payload against DB state
 * inside a single transaction, then persist the envelope to disk.
 *
 * Provider diffing logic lives in ./apply/*; this file owns the payload
 * split, the transaction orchestration, and re-exports the stable public
 * surface (applyProviders / syncDeprecationFlags are also consumed
 * directly by sibling config modules).
 */

import { ApplyConfigPayloadSchema } from '@/schemas/api/config'
import type { Provider } from '@/schemas/domain'
import { getPrismaClient } from '../../db/client'
import type { Prisma } from '../../generated/prisma/client'
import { resetLlmsContext } from '../../llms'
import { syncLoggerFromEnv } from '../../logger'
import { applyProviders } from './apply/providers'
import { RETIRED_ENVELOPE_KEYS } from './compose'
import { applyEnvelopeToEnv, readRawConfigFile, writeConfigFile } from './envelope'
import { pruneUnsetEnvelopePaths } from './sync-to-disk'

export { apiKeyForStorage } from './apply/fields'
export { syncDeprecationFlags } from './apply/model-rows'
export { applyProviderRow, applyProviders } from './apply/providers'

// Prisma 7 hangs the transaction-client type off the namespace export.
export type Tx = Prisma.TransactionClient

export type ApplyResult = {
  success: true
  warnings: string[]
}

export type SplitPayload = {
  envelope: Record<string, unknown>
  // undefined = the key was absent from the payload, so the store is left
  // untouched. A partial save must never wipe what it didn't send — an
  // empty [] would read as "delete everything".
  incomingProviders: Provider[] | undefined
  // Retired keys the payload carried, dropped before anything is
  // stored. Reported so a caller still sending them learns they went
  // nowhere.
  droppedKeys: string[]
}

// Parse the unvalidated UI payload at the boundary, then split into
// envelope / DB-bound parts. ApplyConfigPayloadSchema treats Providers
// as optional, so the schema is happy with partial payloads (CRUD
// endpoints pass single-key shapes).
//
// The schema is `.catchall`, which is what lets an operator keep their
// own keys on disk — and what would let an old UI bundle re-plant
// `Router` there, where it would surface again on the next GET. The
// retired keys are therefore filtered out here by name rather than
// left to the catchall.
//
// `ActivePersona` is an ordinary envelope key: an empty string / null
// clears it (pruneUnsetEnvelopePaths drops it off disk); an absent key
// leaves the current selection alone, so a save from another screen
// does not wipe it.
export const splitPayload = (payload: Record<string, unknown>): SplitPayload => {
  const parsed = ApplyConfigPayloadSchema.parse(payload)
  const { Providers, ...rest } = parsed
  const droppedKeys = RETIRED_ENVELOPE_KEYS.filter((key) => key in rest)
  for (const key of droppedKeys) delete rest[key]
  return {
    envelope: rest,
    // Keep "absent" as undefined so applyUiConfig can skip the store
    // entirely instead of treating an omitted Providers as a request to
    // delete everything it holds.
    incomingProviders: Providers,
    droppedKeys
  }
}

export async function applyUiConfig(payload: Record<string, unknown>): Promise<ApplyResult> {
  const { envelope, incomingProviders, droppedKeys } = splitPayload(payload)
  const warnings: string[] = []
  if (droppedKeys.length > 0) {
    warnings.push(
      `Ignored retired config key(s): ${droppedKeys.join(', ')}. Routing is configured as a chain under Routing; nothing was stored for them.`
    )
  }

  const prisma = getPrismaClient()

  // The whole DB mutation is one interactive transaction so a provider
  // delete and the model rows it takes with it either both land or
  // neither does.
  await prisma.$transaction(async (tx) => {
    // Skip a store the payload didn't include, so a partial save leaves
    // the omitted store intact instead of wiping it — the bug this
    // guards against cascaded from a Provider delete all the way to
    // OAuth accounts.
    if (incomingProviders !== undefined) await applyProviders(tx, incomingProviders, warnings)
  })

  // Envelope changes happen on disk after the DB transaction commits;
  // we accept the small window where the two stores disagree because
  // failing the file write after a DB commit is no worse than failing
  // the DB write after a file write — and the file is the smaller of
  // the two surfaces.
  //
  // Merge onto the raw disk envelope so a partial POST (single-key
  // edit, or a CRUD handler that only touches one scalar) preserves
  // everything the payload did not send. Before this, `writeConfigFile`
  // received only the incoming envelope keys and clobbered every other
  // scalar on disk — APIKEY, PORT, LOG, etc. — because it rewrites the
  // whole file. `readRawConfigFile` returns `{}` when the file is
  // missing so a first-run boot still writes fresh state instead of
  // failing here.
  //
  // A retired key that is still on disk from an older build is dropped
  // here too, so the next save is what prunes it. Don't persist null /
  // '' for the optional scalars — drop the key so "unset" stays absent
  // on disk (composeUiConfig re-derives null). A real value is written
  // through unchanged.
  const { Providers: _p, providers: _lower, ...diskEnvelope } = await readRawConfigFile()
  const mergedEnvelope: Record<string, unknown> = { ...diskEnvelope, ...envelope }
  for (const key of RETIRED_ENVELOPE_KEYS) delete mergedEnvelope[key]
  const envelopeToWrite = pruneUnsetEnvelopePaths(mergedEnvelope)
  await writeConfigFile({
    ...envelopeToWrite,
    ...(incomingProviders !== undefined ? { Providers: incomingProviders } : {})
  })

  // Keep process.env in sync with what we just wrote to disk. The
  // read-side env overlay in readConfigFile() reasserts process.env
  // over disk on every read, so a UI-changed scalar (LOG_LEVEL is the
  // usual culprit) would otherwise be silently clobbered on the next
  // GET by the value applyEnvelopeToEnv() mirrored at boot. Also
  // nudges the pino logger so a LOG_LEVEL change takes effect without
  // a restart. A partial save (e.g. Providers-only) sends an empty
  // envelope here; applyEnvelopeToEnv skips absent keys, so this is a
  // no-op in that case.
  applyEnvelopeToEnv(envelopeToWrite)
  syncLoggerFromEnv()

  // Force the llms context to rebuild on the next request so provider
  // and persona changes take effect immediately without a server restart.
  resetLlmsContext()

  return { success: true, warnings }
}

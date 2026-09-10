/**
 * Re-read DB state and write Providers back to config.json so the file
 * stays in sync after individual CRUD operations.
 *
 * Lives separately from compose / apply / crud because both apply.ts and
 * crud.ts call it, and putting it in either would create a circular
 * import dependency.
 */

import { composeUiConfig, stripDbKeys } from './compose'
import { readConfigFile, writeConfigFile } from './envelope'

// Optional envelope scalars. Their "unset" state is null on the wire
// (see composeUiConfig); on disk we represent unset as the key being
// absent rather than persisting an explicit null or '' — the next
// composeUiConfig re-derives null from absence. A real value is kept.
export const OPTIONAL_ENVELOPE_PATHS = ['CLAUDE_PATH', 'PROXY_URL', 'ActivePersona'] as const

export const pruneUnsetEnvelopePaths = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...envelope }
  for (const key of OPTIONAL_ENVELOPE_PATHS) {
    const value = out[key]
    if (value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
      delete out[key]
    }
  }
  return out
}

export async function syncToConfigFile(): Promise<void> {
  const raw = await readConfigFile()
  const envelopeOnly = stripDbKeys(raw)
  const full = await composeUiConfig()
  await writeConfigFile({
    ...pruneUnsetEnvelopePaths(envelopeOnly),
    Providers: full.Providers
  })
}

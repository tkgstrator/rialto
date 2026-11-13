/**
 * Create a custom provider: a hand-added endpoint on one of three wire
 * formats, with a model list that is looked up once and otherwise typed by
 * the operator.
 *
 * This is the ordinary provider write (`upsertProvider`) with the three
 * things only this flow knows: the stored endpoint is derived from the typed
 * Base URL, the models come from the endpoint itself when it will say, and
 * nothing is switched on. The provider lands disabled with every model off,
 * the same as a catalog vendor does — what it may serve is decided in the
 * last step of the Connect flow, not guessed here.
 */

import type { z } from '@hono/zod-openapi'
import type { CustomModelsLookup, CustomProviderCreateRequestSchema } from '@/schemas/api/providers'
import type { Provider } from '@/schemas/domain/provider'
import { customEndpointUrl } from '@/shared/custom-provider'
import { getPrismaClient } from '../db/client'
import { fetchCustomModels } from '../vendors/custom'
import { upsertProvider } from './config'

export type CustomProviderInput = z.infer<typeof CustomProviderCreateRequestSchema>

export type CustomProviderResult =
  | { ok: true; provider: Provider; models: CustomModelsLookup; warnings: string[] }
  | { ok: false; reason: 'name_taken' | 'invalid_base_url' }

// Compared case-insensitively: names are stored as typed, and a legacy row
// can hold capitals the slug rule would refuse today. Two providers that
// differ only by case would be one in every URL and every log line.
const nameTaken = async (name: string): Promise<boolean> => {
  const row = await getPrismaClient().provider.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true }
  })
  return row !== null
}

export async function createCustomProvider(
  input: CustomProviderInput,
  fetchImpl: typeof fetch = fetch
): Promise<CustomProviderResult> {
  const name = input.name.trim()
  const endpoint = customEndpointUrl(input.base_url, input.api_style)
  if (endpoint === null) return { ok: false, reason: 'invalid_base_url' }
  // Before the lookup, so a taken name never costs a call to the operator's
  // endpoint with their key.
  if (await nameTaken(name)) return { ok: false, reason: 'name_taken' }

  const found = await fetchCustomModels(
    { baseUrl: input.base_url, apiKey: input.api_key, style: input.api_style },
    fetchImpl
  )
  const ids = found.ok ? found.ids : []

  // The lookup can take seconds; a second Connect flow may have claimed the
  // name meanwhile, and the upsert underneath would overwrite its row.
  if (await nameTaken(name)) return { ok: false, reason: 'name_taken' }

  const { provider, warnings } = await upsertProvider({
    name,
    enabled: false,
    api_base_url: endpoint,
    api_key: input.api_key,
    auth_mode: 'api_key',
    api_style: input.api_style,
    models: ids,
    ...(ids.length > 0 ? { transformer: { _disabledModels: ids } } : {})
  })
  const models: CustomModelsLookup = found.ok
    ? { status: 'found', count: found.ids.length }
    : { status: 'unavailable', error: found.error }
  return { ok: true, provider, models, warnings }
}

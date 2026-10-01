import { z } from 'zod'
import type { ConfigConnection } from './types'

const SubscriptionConfigSchema = z.object({
  Providers: z
    .array(
      z.object({
        name: z.string().nonempty(),
        auth_mode: z.string().min(0).optional(),
        models: z.array(z.string().nonempty()).default([]),
        transformer: z.object({ _disabledModels: z.array(z.string().nonempty()).default([]) }).optional()
      })
    )
    .default([])
})

/** The same enabled subscription models the provider test helpers enumerate. */
export async function loadSubscriptionMatrix(
  connection: ConfigConnection
): Promise<{ name: string; models: string[] }[]> {
  const res = await fetch(connection.configUrl, { headers: { 'x-api-key': connection.apiKey } })
  if (!res.ok) throw new Error(`GET /api/config -> HTTP ${res.status}`)
  const cfg = SubscriptionConfigSchema.safeParse(await res.json())
  if (!cfg.success) throw new Error('GET /api/config -> invalid subscription config')
  return cfg.data.Providers.filter((provider) => provider.auth_mode === 'subscription').map((provider) => {
    const disabled = new Set(provider.transformer === undefined ? [] : provider.transformer._disabledModels)
    return { name: provider.name, models: provider.models.filter((model) => !disabled.has(model)) }
  })
}

// Preserve each provider's other fields: saving only names and keys would
// drop its models and transformer settings on the live config round trip.
const ProviderSchema = z.object({ name: z.string().nonempty(), api_key: z.string().min(0).nullable() }).loose()
const FullConfigSchema = z.object({ Providers: z.array(ProviderSchema).default([]) }).loose()
const InjectionStateSchema = z.object({ prior: z.record(z.string().nonempty(), z.string().min(0).nullable()) })
export type InjectionState = z.infer<typeof InjectionStateSchema>

async function fetchFullConfig(connection: ConfigConnection) {
  const res = await fetch(connection.configUrl, {
    headers: { 'x-api-key': connection.apiKey, 'Accept-Encoding': 'identity' }
  })
  if (!res.ok) throw new Error(`GET /api/config -> HTTP ${res.status}`)
  const cfg = FullConfigSchema.safeParse(await res.json())
  if (!cfg.success) throw new Error('GET /api/config -> invalid provider config')
  return cfg.data
}

async function postProvidersUpdate(
  connection: ConfigConnection,
  providers: z.infer<typeof ProviderSchema>[]
): Promise<void> {
  // Missing providers are deleted by applyUiConfig, so round-trip the whole list.
  const res = await fetch(connection.configUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': connection.apiKey,
      'Accept-Encoding': 'identity'
    },
    body: JSON.stringify({ Providers: providers })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`POST /api/config -> HTTP ${res.status}: ${text}`)
  }
}

const INJECTION_TARGETS = [
  { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  { provider: 'google', envVar: 'GEMINI_API_KEY' }
]

/** Temporary keys for recording; subscription providers are untouched. */
export async function injectApiKeys(connection: ConfigConnection): Promise<InjectionState | null> {
  if (process.env.NO_INJECT) {
    console.log('inject: skipped (NO_INJECT set)')
    return null
  }
  const cfg = await fetchFullConfig(connection)
  const providers = cfg.Providers
  const prior: InjectionState['prior'] = {}
  for (const { provider, envVar } of INJECTION_TARGETS) {
    const value = process.env[envVar]
    if (!value) {
      console.log(`inject: ${envVar} not set, skipping ${provider}`)
      continue
    }
    const row = providers.find((p) => p.name === provider)
    if (!row) {
      console.log(`inject: provider "${provider}" not in /api/config, skipping`)
      continue
    }
    prior[provider] = row.api_key
    row.api_key = value
    console.log(`inject: ${provider}.api_key set from ${envVar}`)
  }
  if (Object.keys(prior).length === 0) return null
  await postProvidersUpdate(connection, providers)
  return { prior }
}

export async function restoreApiKeys(connection: ConfigConnection, state: InjectionState): Promise<void> {
  const cfg = await fetchFullConfig(connection)
  const providers = cfg.Providers
  for (const [name, prevValue] of Object.entries(state.prior)) {
    const row = providers.find((p) => p.name === name)
    if (!row) continue
    row.api_key = prevValue
    console.log(`restore: ${name}.api_key reset to ${prevValue === null ? 'null' : '<prior value>'}`)
  }
  await postProvidersUpdate(connection, providers)
}

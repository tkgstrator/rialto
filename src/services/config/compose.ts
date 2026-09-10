/**
 * Read-side composition: join the on-disk envelope with the DB-resident
 * Providers table into the `AppConfig` shape consumed by the API / UI.
 */

import type { AppConfig } from '@/schemas/api/config'
import type { Provider } from '@/schemas/domain'
import type { ConfigEnvelope } from '@/shared'
import { getPrismaClient } from '../../db/client'
import {
  type ApiStyle,
  AuthMode,
  type Model as DbModel,
  type Provider as DbProvider,
  ModelTestStatus
} from '../../generated/prisma/client'
import { readConfigFile } from './envelope'

export type ProviderWithModels = DbProvider & {
  models: DbModel[]
  subscriptionAccounts?: { id: string; enabled: boolean }[]
}

/**
 * The `transformer` blob as the UI sees it.
 *
 * There is no stored blob any more — `Provider.transformer` was dropped
 * when `providerEnabled` became `Provider.enabled`. What is left is a
 * pure projection of `Model.enabled` that the provider editor and
 * ModelsDashboard still read under its old name, so the wire shape is
 * unchanged for the screens. Undefined when nothing is disabled, so a
 * fully enabled provider sends no key at all.
 */
const toWireTransformer = (disabledModels: string[]): Record<string, unknown> | undefined =>
  disabledModels.length === 0 ? undefined : { _disabledModels: disabledModels }

export const toProvider = (p: ProviderWithModels): Provider => {
  const deprecatedModels = p.models.filter((m) => m.deprecated).map((m) => m.name)
  // Model.enabled is the source of truth. Synthesize the
  // transformer._disabledModels view that the provider editor /
  // ModelsDashboard read so the UI sees the DB state directly.
  const disabledModels = p.models.filter((m) => !m.enabled).map((m) => m.name)
  const transformerOut = toWireTransformer(disabledModels)
  const tested = p.models.filter((m) => m.testStatus !== ModelTestStatus.unknown)
  const modelTestStatus: Record<string, { status: 'unknown' | 'ok' | 'fail'; passedAt: string | null }> =
    Object.fromEntries(
      tested.map((m) => [
        m.name,
        {
          // Prisma's enum value is the union we want verbatim — convert
          // through the enum reverse map rather than asserting the
          // literal type.
          status: m.testStatus,
          passedAt: m.testPassedAt ? m.testPassedAt.toISOString() : null
        }
      ])
    )
  const withContext = p.models.filter((m): m is DbModel & { contextWindow: number } => m.contextWindow !== null)
  const modelContextWindows = Object.fromEntries(withContext.map((m) => [m.name, m.contextWindow]))
  // Expose DB-held prices (scraped or backfilled from llm-prices.json) so
  // the dashboard can read prices without any frontend static fallback.
  const withPrice = p.models.filter((m) => m.inputPer1M !== null || m.outputPer1M !== null)
  const modelPrices = Object.fromEntries(
    withPrice.map((m) => [m.name, { inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M }])
  )
  const withManualTier = p.models.filter(
    (m): m is DbModel & { manualTier: 'fable' | 'opus' | 'sonnet' | 'haiku' } =>
      m.manualTier === 'fable' || m.manualTier === 'opus' || m.manualTier === 'sonnet' || m.manualTier === 'haiku'
  )
  const modelManualTiers = Object.fromEntries(withManualTier.map((m) => [m.name, m.manualTier]))
  const withApiStyle = p.models.filter((m): m is DbModel & { apiStyle: ApiStyle } => m.apiStyle !== null)
  const modelApiStyles = Object.fromEntries(withApiStyle.map((m) => [m.name, m.apiStyle]))
  const withReasoningEffort = p.models.filter(
    (m): m is DbModel & { reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } =>
      m.reasoningEffort === 'none' ||
      m.reasoningEffort === 'minimal' ||
      m.reasoningEffort === 'low' ||
      m.reasoningEffort === 'medium' ||
      m.reasoningEffort === 'high' ||
      m.reasoningEffort === 'xhigh' ||
      m.reasoningEffort === 'max'
  )
  const modelReasoningEfforts = Object.fromEntries(withReasoningEffort.map((m) => [m.name, m.reasoningEffort]))
  return {
    name: p.name,
    enabled: p.enabled,
    api_base_url: p.apiBaseUrl,
    // DB value verbatim: null when unset. Never coerced to ''.
    api_key: p.apiKey,
    auth_mode: p.authMode,
    api_style: p.apiStyle,
    models: p.models.map((m) => m.name),
    ...(deprecatedModels.length > 0 ? { deprecatedModels } : {}),
    ...(tested.length > 0 ? { modelTestStatus } : {}),
    ...(withContext.length > 0 ? { modelContextWindows } : {}),
    ...(withPrice.length > 0 ? { modelPrices } : {}),
    ...(withManualTier.length > 0 ? { modelManualTiers } : {}),
    ...(withApiStyle.length > 0 ? { modelApiStyles } : {}),
    ...(withReasoningEffort.length > 0 ? { modelReasoningEfforts } : {}),
    // Not a stored value: _disabledModels is derived from Model.enabled
    // on every read, which is why the JSONB column it used to share with
    // `providerEnabled` could be dropped outright.
    ...(transformerOut ? { transformer: transformerOut } : {}),
    // Subscription providers expose each discovered SubAccount's
    // enable/disable state so the editor can render a switch list and
    // round-trip the user's toggles through applyUiConfig.
    ...(p.authMode === AuthMode.subscription && p.subscriptionAccounts
      ? {
          subscription_accounts: p.subscriptionAccounts.map((a) => ({
            id: a.id,
            enabled: a.enabled
          }))
        }
      : {})
  }
}

// Optional string scalars travel as null on the wire when unset (absent
// / '' on disk). Collapse a raw envelope value to that null-or-string
// shape in one place so composeUiConfig stays flat.
export const optionalScalarOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.length > 0 ? raw : null

// Envelope keys a retired feature used to write: the RouterSlot mirror,
// the custom-router hook that nothing ever read, the routing display
// name, the cross-provider peer toggle, and the `APIKEY` bootstrap token
// /api/* no longer accepts. They are read by nothing. Stripped on every
// read so a stale copy on disk cannot reach the wire — for APIKEY that
// copy is a plaintext secret — and dropped from every save so the next
// write leaves them off disk.
export const RETIRED_ENVELOPE_KEYS = [
  'Router',
  'CUSTOM_ROUTER_PATH',
  'LiveRoutingName',
  'CROSS_PROVIDER_FALLBACK',
  'APIKEY'
] as const

// Strip the DB-resident and retired keys out of an on-disk envelope read
// so the composed result reflects the DB, not stale disk content.
export const stripDbKeys = (envelope: ConfigEnvelope): ConfigEnvelope => {
  const { Providers: _p, ...rest } = envelope
  for (const key of RETIRED_ENVELOPE_KEYS) delete rest[key]
  return rest
}

export async function composeUiConfig(): Promise<AppConfig> {
  const envelope = await readConfigFile()
  const envelopeOnly = stripDbKeys(envelope)

  const prisma = getPrismaClient()
  const providers = await prisma.provider.findMany({
    include: {
      // Ordered for the same reason subscriptionAccounts is: a relation
      // with no orderBy comes back in whatever order Postgres feels like,
      // and an UPDATE moves the row. Toggling a model on the Providers
      // screen therefore reshuffled the table under the operator's
      // cursor. createdAt is the seed/insert order the UI was built
      // around; name breaks the ties, because a createMany batch stamps
      // every row with the same instant.
      models: { orderBy: [{ createdAt: 'asc' }, { name: 'asc' }] },
      subscriptionAccounts: { orderBy: { createdAt: 'asc' } }
    },
    orderBy: { createdAt: 'asc' }
  })

  // Optional scalars: emit null when absent / '' on disk so the JSON
  // editor / wire shows "no value" consistently. The active persona is
  // one of them — a top-level key on the wire, backed by the same key
  // on disk.
  return {
    ...envelopeOnly,
    CLAUDE_PATH: optionalScalarOrNull(envelopeOnly.CLAUDE_PATH),
    PROXY_URL: optionalScalarOrNull(envelopeOnly.PROXY_URL),
    ActivePersona: optionalScalarOrNull(envelopeOnly.ActivePersona),
    Personas: envelopeOnly.Personas,
    Providers: providers.map(toProvider)
  }
}

export async function loadFullConfig(): Promise<AppConfig> {
  return composeUiConfig()
}

import type { z } from '@hono/zod-openapi'
import { VENDOR_DEFAULTS } from '@/shared'
import { hasAuthenticableAccount, hasUnexpiredAccount } from '@/shared/subscription-credential'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import type { ProviderTestResponseSchema } from '../schemas/api/providers'
import { getSubscriptionsInfo } from './subscription-info-service'

export type ProviderTestResult = z.infer<typeof ProviderTestResponseSchema>

const probeApiKey = async (vendor: string, apiKey: string): Promise<{ ok: boolean; error?: string }> => {
  const defaults = VENDOR_DEFAULTS[vendor]
  if (!defaults?.modelsEndpoint || !defaults.modelsAuth) {
    return { ok: false, error: `vendor "${vendor}" has no /v1/models endpoint configured for testing` }
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  let url = defaults.modelsEndpoint
  if (defaults.modelsAuth === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`
  } else if (defaults.modelsAuth === 'x-api-key') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (defaults.modelsAuth === 'google-key-param') {
    url += `?key=${encodeURIComponent(apiKey)}`
  }
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return { ok: false, error: `upstream returned HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' }
  }
}

export async function testProvider(name: string): Promise<ProviderTestResult> {
  const start = dayjs()
  const prisma = getPrismaClient()
  const provider = await prisma.provider.findUnique({ where: { name } })
  if (!provider) {
    return { success: false, latencyMs: dayjs().diff(start), error: `provider "${name}" not found` }
  }
  if (!provider.enabled) {
    return { success: false, latencyMs: dayjs().diff(start), error: 'provider is disabled' }
  }
  if (provider.authMode === 'subscription') {
    const subs = await getSubscriptionsInfo()
    const match = subs.find((s) => s.providerName === name)
    if (match && !match.enabled) {
      return { success: false, latencyMs: dayjs().diff(start), error: 'provider is disabled' }
    }
    // Any connected account makes the provider usable — the proxy picks
    // between them per request, so one expired token is not a verdict on
    // the provider while a peer still authenticates.
    const accounts = match === undefined ? [] : match.accounts
    if (!hasAuthenticableAccount(accounts)) {
      return {
        success: false,
        latencyMs: dayjs().diff(start),
        error: 'no subscription credentials on disk — log in with the vendor CLI first'
      }
    }
    if (!hasUnexpiredAccount(accounts, dayjs().valueOf())) {
      return {
        success: false,
        latencyMs: dayjs().diff(start),
        error: 'subscription token has expired — refresh by logging in again'
      }
    }
    return { success: true, latencyMs: dayjs().diff(start) }
  }
  if (!provider.apiKey || provider.apiKey.trim() === '') {
    return { success: false, latencyMs: dayjs().diff(start), error: 'no api key on file' }
  }
  const probe = await probeApiKey(provider.name, provider.apiKey)
  return { success: probe.ok, latencyMs: dayjs().diff(start), error: probe.error }
}

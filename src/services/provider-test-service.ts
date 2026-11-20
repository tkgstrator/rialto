import type { z } from '@hono/zod-openapi'
import { VENDOR_DEFAULTS } from '@/shared'
import { apiKeyVendorName, isCustomApiStyle, isCustomProvider } from '@/shared/custom-provider'
import { hasAuthenticableAccount, hasUnexpiredAccount } from '@/shared/subscription-credential'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import type { ProviderTestResponseSchema } from '../schemas/api/providers'
import { fetchCustomModels } from '../vendors/custom'
import { getSubscriptionsInfo } from './subscription-info-service'

export type ProviderTestResult = z.infer<typeof ProviderTestResponseSchema>

// A custom provider has no catalog entry to look its models endpoint up in;
// its own stored URL is the only address there is. The probe is the same
// models lookup the Connect flow runs, so "reachable and the key is accepted"
// means the same thing in both places.
const probeCustom = async (
  provider: { apiBaseUrl: string; apiStyle: string },
  apiKey: string
): Promise<{ ok: boolean; error?: string }> => {
  const style = isCustomApiStyle(provider.apiStyle) ? provider.apiStyle : 'openai_chat'
  const result = await fetchCustomModels({ baseUrl: provider.apiBaseUrl, apiKey, style })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

type ApiKeyProbe = { ok: boolean; error?: string; organizationId?: string; workspaceId?: string; projectId?: string }

const probeApiKey = async (vendor: string, apiKey: string): Promise<ApiKeyProbe> => {
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
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      if (defaults.modelsAuth === 'x-api-key' && res.status === 400) {
        const body = await res.text()
        if (body.includes('This API key is not scoped to a workspace') && body.includes('anthropic-workspace-id')) {
          return { ok: false, error: 'Use an Anthropic API key scoped to a workspace.' }
        }
      }
      return { ok: false, error: `upstream returned HTTP ${res.status}` }
    }
    if (vendor === 'openai') {
      const project = res.headers.get('openai-project')
      const organization = res.headers.get('openai-organization')
      return {
        ok: true,
        ...(project && /^proj_[a-z0-9]+$/i.test(project) ? { projectId: project } : {}),
        ...(organization && /^org-[a-z0-9]+$/i.test(organization) ? { organizationId: organization } : {})
      }
    }
    if (vendor !== 'anthropic') return { ok: true }
    const organizationId = res.headers.get('anthropic-organization-id')
    const workspaceId = res.headers.get('anthropic-workspace-id')
    return {
      ok: true,
      ...(organizationId ? { organizationId } : {}),
      ...(workspaceId ? { workspaceId } : {})
    }
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
  const probe: ApiKeyProbe = isCustomProvider(provider.name, provider.authMode)
    ? await probeCustom(provider, provider.apiKey)
    : await probeApiKey(apiKeyVendorName(provider.name), provider.apiKey)
  const { ok, ...details } = probe
  if (ok && (details.organizationId || details.workspaceId || details.projectId)) {
    await prisma.provider.updateMany({
      where: { id: provider.id, apiKey: provider.apiKey, apiBaseUrl: provider.apiBaseUrl, authMode: provider.authMode },
      data: { organizationId: details.organizationId, workspaceId: details.workspaceId, projectId: details.projectId }
    })
  }
  return { success: ok, latencyMs: dayjs().diff(start), ...details }
}

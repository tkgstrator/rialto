/**
 * Server calls the add-provider flow makes.
 *
 * Order matters in one place: the Provider row must exist BEFORE the OAuth
 * exchange completes. `recordClaudeOAuthAccount` / `recordCodexOAuthAccount`
 * attach the discovered account to whichever subscription provider matches
 * the vendor's base URL, and silently skip the upsert when none does — so
 * signing in first and creating the provider afterwards loses the account.
 */
import { api } from '@/lib/api'
import type { OAuthKind } from './ConnectAuthStep'
import type { CatalogEntry, OAuthInitiateResponse, OAuthSubmitResponse, Provider } from './types'

// react-i18next's t(), trimmed to the shape these fallbacks call. Taking it
// as a parameter keeps this module free of React, the way form-logic.ts is.
type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Which token exchange the server can run for a vendor.
 *
 * Mirrors `providersForKind` in subscription-account-sync/persist.ts: the
 * match is on the base URL, not the provider name, so a self-hosted proxy
 * pointed at the vendor still resolves. Null means this build has no
 * exchange for the vendor and only the credential import can work.
 */
export function oauthKindOf(entry: CatalogEntry): OAuthKind | null {
  if (entry.authMode !== 'subscription') return null
  if (entry.apiBaseUrl.includes('anthropic.com')) return 'claude'
  if (entry.apiBaseUrl.includes('chatgpt.com') || entry.apiBaseUrl.includes('openai.com/v1')) return 'codex'
  return null
}

/**
 * A fresh Provider row seeded from the catalog.
 *
 * Subscription vendors get the whole curated catalog with anything outside
 * the plan's defaults switched off, so the model table shows the full
 * advertised set as opt-in. api_key vendors get just the defaults — their
 * catalogs run to dozens of models nobody asked for. Lands disabled: the
 * vendor must not be called before the credential is in place.
 */
export function providerFromCatalog(entry: CatalogEntry): Provider {
  const offered = entry.models.filter((m) => !m.deprecated && !m.legacy).map((m) => m.name)
  const defaults = entry.defaultEnabledModels
  if (entry.authMode === 'subscription') {
    const models = offered.length > 0 ? offered : defaults
    const defaultSet = new Set(defaults)
    const disabled = models.filter((n) => !defaultSet.has(n))
    return {
      name: entry.name,
      api_base_url: entry.apiBaseUrl,
      api_key: null,
      auth_mode: entry.authMode,
      enabled: false,
      models,
      ...(disabled.length > 0 ? { transformer: { _disabledModels: disabled } } : {})
    }
  }
  return {
    name: entry.name,
    api_base_url: entry.apiBaseUrl,
    api_key: null,
    auth_mode: entry.authMode,
    enabled: false,
    models: defaults.length > 0 ? defaults : offered
  }
}

/** Create the row if the vendor has not been added yet. Idempotent — POST upserts. */
export async function ensureProvider(entry: CatalogEntry): Promise<void> {
  if (entry.enabled) return
  await api.post('/providers', providerFromCatalog(entry))
}

/** Open the vendor's consent page in a new tab. Returns the flow's state token. */
export async function startOAuth(kind: OAuthKind, t: Translate): Promise<string> {
  const res = await api.post<OAuthInitiateResponse>(`/oauth/initiate/${kind}`, {})
  if (!res.success || res.authorizeUrl === undefined) {
    throw new Error(res.error === undefined ? t('providers.connect.errorStartOauth') : res.error)
  }
  window.open(res.authorizeUrl, '_blank', 'noopener,noreferrer')
  return res.state === undefined ? '' : res.state
}

/** Relay a redirect URL the browser could not deliver to the loopback callback. */
export async function submitManualCallback(url: string, t: Translate): Promise<void> {
  const res = await api.post<OAuthSubmitResponse>('/oauth/manual-callback', { url: url.trim() })
  if (!res.success) throw new Error(res.error === undefined ? t('providers.connect.errorRedirect') : res.error)
}

/** undefined signals "not valid JSON" — JSON.parse never returns it for a well-formed document. */
async function parseJsonFile(file: File): Promise<unknown> {
  try {
    return JSON.parse(await file.text())
  } catch {
    return undefined
  }
}

export async function importCredentials(kind: OAuthKind, file: File, t: Translate): Promise<void> {
  const parsed = await parseJsonFile(file)
  if (parsed === undefined) throw new Error(t('providers.connect.errorNotJson', { name: file.name }))
  const res = await api.post<OAuthSubmitResponse>('/oauth/import-credentials', { provider: kind, credentials: parsed })
  if (!res.success) throw new Error(res.error === undefined ? t('providers.connect.errorCredentials') : res.error)
}

/** Seed the row and its key in one upsert, then switch the provider on. */
export async function saveNewApiKey(entry: CatalogEntry, apiKey: string): Promise<void> {
  await api.post('/providers', { ...providerFromCatalog(entry), api_key: apiKey.trim(), enabled: true })
}

/** Finish the flow: the provider has a credential, so it may take traffic. */
export async function enableProvider(provider: Provider): Promise<void> {
  await api.post('/providers', { ...provider, enabled: true })
}

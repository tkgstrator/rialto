import type {
  AccessTokenWire,
  AppDeviceWire,
  AuthorizedAppWire,
  HealthResponse,
  IdentityResponse,
  InboundSurfaceWire,
  InboundType,
  ModelTier,
  OverviewResponse,
  PlanInputWire,
  PlanWire,
  RequestLogItem,
  ResetCreditsResponse,
  RoutingMode,
  RoutingSchedulerStateResponse,
  SessionMessageItem,
  SessionSummary,
  SurfaceId,
  TierAliasWire,
  TierProfileSaveOutcome,
  TierProfileSummaryWire,
  TierProfileViewWire,
  TierProfileWriteWire,
  TokenScopeId,
  UpdateCheckResponse,
  UseResetResponse
} from '@/lib/api-types'
import type { Config } from '@/types'

// Every wire type lives in ./api-types and is re-exported here, so
// `@/lib/api` stays the one import path for both the client and the
// shapes it returns.
export type * from '@/lib/api-types'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// `surfaces[1]` rather than Zod's `["surfaces", 1]`, so the path reads the
// way the request body is written.
function formatIssuePath(path: unknown[]): string {
  return path.reduce<string>((text, part) => {
    if (typeof part === 'number') return `${text}[${part}]`
    if (typeof part === 'string') return `${text}${text ? '.' : ''}${part}`
    return text
  }, '')
}

// An error body is `{error: string}`, `{error: {message}}`, or the
// `validation_error` envelope from api/zod-response.ts. The last one used
// to reach the toast as `[object Object]`, or as Zod's raw JSON dump.
function formatApiError(body: unknown): string | undefined {
  if (!isObject(body)) return undefined
  if (typeof body.message === 'string') return body.message
  const { error } = body
  if (typeof error === 'string') return error
  if (!isObject(error)) return undefined

  if (error.type === 'validation_error' && Array.isArray(error.issues)) {
    const issues = error.issues.flatMap((issue) => {
      if (!isObject(issue) || typeof issue.message !== 'string') return []
      const location = Array.isArray(issue.path) ? formatIssuePath(issue.path) : ''
      const message = issue.message
      return [`${location ? `${location}: ` : ''}${message}`]
    })
    if (issues.length > 0) return issues.join('\n')
  }
  return typeof error.message === 'string' ? error.message : undefined
}

// Browser-side API client. Fetches under `${baseUrl}<endpoint>` and
// attaches no credential: the admin gate admits a browser on the host
// itself, or a request Cloudflare Access has already authenticated at the
// edge, and neither needs anything from this side.
class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string = '/api') {
    this.baseUrl = baseUrl
  }

  private async apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers
      }
    })

    if (response.status === 401) {
      // The event sends the operator to /access-denied; the throw is what
      // stops every caller here.
      //
      // This used to `return new Promise(() => {})` — a promise that
      // never settles — on the theory that navigation would unmount the
      // caller anyway. It does not: a hanging promise means no `.catch`
      // and no `.finally` ever runs, so every screen that fetched sat on
      // its loading state forever with nothing on screen to explain why.
      window.dispatchEvent(new CustomEvent('unauthorized'))
      throw new Error('Unauthorized')
    }

    if (!response.ok) {
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`
      try {
        const formatted = formatApiError(await response.json())
        if (formatted !== undefined) errorMessage = formatted
      } catch {
        // body wasn't JSON; fall back to status line
      }
      throw new Error(errorMessage)
    }

    if (response.status === 204) return {} as T
    const text = await response.text()
    return text ? JSON.parse(text) : ({} as T)
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.apiFetch<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, { method: 'POST', body: JSON.stringify(data) })
  }

  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, { method: 'PUT', body: JSON.stringify(data) })
  }

  async patch<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, { method: 'PATCH', body: JSON.stringify(data) })
  }

  private async deleteRequest<T>(endpoint: string, body: unknown = {}): Promise<T> {
    return this.apiFetch<T>(endpoint, { method: 'DELETE', body: JSON.stringify(body) })
  }

  // Configuration
  async getConfig(): Promise<Config> {
    return this.get<Config>('/config')
  }

  async updateConfig(config: Config): Promise<Config> {
    return this.post<Config>('/config', config)
  }

  // `force` is the operator pressing "Check now". Without it the server
  // may answer from its short cache, which is what keeps a screen that
  // re-mounts from burning the anonymous GitHub rate limit.
  async checkForUpdates(force = false): Promise<UpdateCheckResponse> {
    return this.get<UpdateCheckResponse>(`/update/check?force=${force ? 'true' : 'false'}`)
  }

  // Logs
  async getLogFiles(): Promise<Array<{ name: string; path: string; size: number; lastModified: string }>> {
    return this.get<Array<{ name: string; path: string; size: number; lastModified: string }>>('/logs/files')
  }

  async getLogs(filePath: string): Promise<string[]> {
    return this.get<string[]>(`/logs?file=${encodeURIComponent(filePath)}`)
  }

  async clearLogs(filePath: string): Promise<void> {
    return this.deleteRequest<void>(`/logs?file=${encodeURIComponent(filePath)}`)
  }

  // Request logs
  async getSessionSummary(sessionId: string): Promise<SessionSummary> {
    return this.get<SessionSummary>(`/request-logs/sessions/${encodeURIComponent(sessionId)}/summary`)
  }

  async getSessionLogs(sessionId: string): Promise<{ items: RequestLogItem[] }> {
    return this.get<{ items: RequestLogItem[] }>(`/request-logs/sessions/${encodeURIComponent(sessionId)}`)
  }

  async getSessionMessages(
    sessionId: string,
    params?: { limit?: number; before?: string }
  ): Promise<{ items: SessionMessageItem[]; nextCursor: string | null }> {
    const q = new URLSearchParams()
    if (params?.limit != null) q.set('limit', String(params.limit))
    if (params?.before != null) q.set('before', params.before)
    const qs = q.toString()
    return this.get<{ items: SessionMessageItem[]; nextCursor: string | null }>(
      `/request-logs/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
    )
  }

  async getRequestLogSessions(params?: {
    limit?: number
    offset?: number
    sinceHours?: number
    inboundType?: InboundType
  }): Promise<{
    sessions: SessionSummary[]
    total: number
  }> {
    const q = new URLSearchParams()
    if (params?.limit != null) q.set('limit', String(params.limit))
    if (params?.offset != null) q.set('offset', String(params.offset))
    if (params?.sinceHours != null) q.set('sinceHours', String(params.sinceHours))
    if (params?.inboundType != null) q.set('inboundType', params.inboundType)
    const qs = q.toString()
    return this.get<{ sessions: SessionSummary[]; total: number }>(`/request-logs/sessions${qs ? `?${qs}` : ''}`)
  }

  // Archive every active session: it drops out of the History list while its
  // cost/usage totals are preserved. Returns the number of sessions archived.
  async archiveAllSessions(): Promise<{ archived: number }> {
    return this.post<{ archived: number }>('/request-logs/sessions/archive', {})
  }

  // ─── Scenario routes ─────────────────────────────────────────────────
  // A profile's routes per scenario and lane, each resolved through its
  // provider's alias on read. PUT replaces the whole profile.
  async getTierProfiles(): Promise<TierProfileSummaryWire[]> {
    return this.get<TierProfileSummaryWire[]>('/routing/profiles')
  }

  async getTierProfile(key: string): Promise<TierProfileViewWire> {
    return this.get<TierProfileViewWire>(`/routing/profiles/${encodeURIComponent(key)}`)
  }

  async putTierProfile(key: string, profile: TierProfileWriteWire): Promise<TierProfileSaveOutcome> {
    return this.put<TierProfileSaveOutcome>(`/routing/profiles/${encodeURIComponent(key)}`, profile)
  }

  // ─── Provider tier aliases ───────────────────────────────────────────
  async getTierAliases(): Promise<TierAliasWire[]> {
    return this.get<TierAliasWire[]>('/tier-aliases')
  }

  // Point the provider's tier at a model — "promote". Switches the model
  // on as well.
  async setTierAlias(provider: string, tier: ModelTier, model: string): Promise<{ enabledModel: boolean }> {
    return this.put<{ enabledModel: boolean }>(`/providers/${encodeURIComponent(provider)}/tier-aliases/${tier}`, {
      model
    })
  }

  async clearTierAlias(provider: string, tier: ModelTier): Promise<void> {
    await this.apiFetch<void>(`/providers/${encodeURIComponent(provider)}/tier-aliases/${tier}`, { method: 'DELETE' })
  }

  // Router scheduler snapshot (Phase 5). Read-only. Cold-boot returns
  // an empty snapshot with tickAt=null so the UI renders "no data yet"
  // without a special path.
  // The account's spendable banked resets, read from OpenAI now, soonest
  // to lapse first, and how many apply right now.
  async getResetCredits(subAccountId: string): Promise<ResetCreditsResponse> {
    return this.get<ResetCreditsResponse>(`/subscriptions/accounts/${encodeURIComponent(subAccountId)}/reset-credits`)
  }

  // Spend the credit closest to lapsing. Irreversible on OpenAI's side;
  // the caller asks first.
  async spendResetCredit(subAccountId: string): Promise<UseResetResponse> {
    return this.post<UseResetResponse>(`/subscriptions/accounts/${encodeURIComponent(subAccountId)}/reset-usage`, {})
  }

  async getRoutingSchedulerState(): Promise<RoutingSchedulerStateResponse> {
    return this.get<RoutingSchedulerStateResponse>('/routing-scheduler-state')
  }

  // Set a per-model reasoning-effort override. Send null to clear and
  // fall back to the vendor default. Reuses PATCH
  // /api/providers/{name}/models/{model}.
  async setModelReasoningEffort(
    providerName: string,
    modelName: string,
    reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | null
  ): Promise<{ success: boolean }> {
    return this.apiFetch<{ success: boolean }>(
      `/providers/${encodeURIComponent(providerName)}/models/${encodeURIComponent(modelName)}`,
      { method: 'PATCH', body: JSON.stringify({ reasoningEffort }) }
    )
  }

  // Overview screen. One call for the whole summary so its blocks all
  // describe the same instant.
  async getOverview(params?: { windowHours?: number }): Promise<OverviewResponse> {
    const q = new URLSearchParams()
    if (params?.windowHours != null) q.set('windowHours', String(params.windowHours))
    const qs = q.toString()
    return this.get<OverviewResponse>(`/overview${qs ? `?${qs}` : ''}`)
  }

  // Inbound surfaces + their effective routing mode.
  async getInboundSurfaces(): Promise<{ surfaces: InboundSurfaceWire[] }> {
    return this.get<{ surfaces: InboundSurfaceWire[] }>('/inbound-surfaces')
  }

  async updateInboundSurface(body: {
    surface: SurfaceId
    routingMode: RoutingMode
    profileKey?: string | null
    // Omit to leave the stored list alone — the mode and profile writers
    // do, and must not blank it by saying nothing.
    deniedTargets?: string[]
  }): Promise<{ surfaces: InboundSurfaceWire[] }> {
    return this.post<{ surfaces: InboundSurfaceWire[] }>('/inbound-surfaces', body)
  }

  // Access tokens (Phase 3.5). Issue returns the plaintext once; there is
  // no endpoint that can show it again.
  /**
   * `manual` leaves out the tokens app installs minted for themselves —
   * the Tokens tab's list. Activity reads them all, so its spend shares
   * add up to what the window cost.
   */
  async getAccessTokens(issued: 'all' | 'manual' = 'all'): Promise<{ tokens: AccessTokenWire[] }> {
    return this.get<{ tokens: AccessTokenWire[] }>(`/access-tokens?issued=${issued}`)
  }

  async issueAccessToken(body: {
    name: string
    /**
     * Omitted or empty issues a token that may call every /v1 surface —
     * but not /codex, which only a list naming 'codex-mcp' grants.
     */
    surfaces?: TokenScopeId[]
    profileKey?: string | null
    expiresAt?: string | null
    /** The plan the token spends under. Null or omitted = unrestricted. */
    planId?: string | null
  }): Promise<{ token: AccessTokenWire; plaintext: string }> {
    return this.post<{ token: AccessTokenWire; plaintext: string }>('/access-tokens', body)
  }

  async getAccessToken(id: string): Promise<AccessTokenWire> {
    return this.get<AccessTokenWire>(`/access-tokens/${encodeURIComponent(id)}`)
  }

  /**
   * Change what an existing token may do.
   *
   * Scope, profile and plan — the things about a token that
   * legitimately change while the client keeps the same credential.
   */
  async updateAccessToken(
    id: string,
    body: { surfaces?: TokenScopeId[]; profileKey?: string | null; planId?: string | null }
  ): Promise<AccessTokenWire> {
    return this.patch<AccessTokenWire>(`/access-tokens/${encodeURIComponent(id)}`, body)
  }

  /**
   * Replace a token's secret in place.
   *
   * Same row, same statistics, same attribution on every request it has
   * already served — only the credential changes, and the old one stops
   * working the moment this resolves. Rejects with `revoked` / `expired`
   * for a row that could not authenticate anyway.
   */
  async rotateAccessToken(id: string): Promise<{ token: AccessTokenWire; plaintext: string }> {
    return this.post<{ token: AccessTokenWire; plaintext: string }>(
      `/access-tokens/${encodeURIComponent(id)}/rotate`,
      {}
    )
  }

  async revokeAccessToken(id: string): Promise<AccessTokenWire> {
    return this.post<AccessTokenWire>(`/access-tokens/${encodeURIComponent(id)}/revoke`, {})
  }

  // Prefer revoke: deleting a token also deletes the answer to "whose
  // requests were these" on every RequestLog row it authenticated.
  async deleteAccessToken(id: string): Promise<{ deleted: boolean }> {
    return this.deleteRequest<{ deleted: boolean }>(`/access-tokens/${encodeURIComponent(id)}`)
  }

  // Plans. An edit reaches every token on the plan at its next request.
  async getPlans(): Promise<{ plans: PlanWire[] }> {
    return this.get<{ plans: PlanWire[] }>('/plans')
  }

  async createPlan(body: PlanInputWire): Promise<PlanWire> {
    return this.post<PlanWire>('/plans', body)
  }

  async updatePlan(id: string, body: Partial<PlanInputWire>): Promise<PlanWire> {
    return this.patch<PlanWire>(`/plans/${encodeURIComponent(id)}`, body)
  }

  // Refused (409) while any token or app is on the plan.
  async deletePlan(id: string): Promise<{ deleted: boolean }> {
    return this.deleteRequest<{ deleted: boolean }>(`/plans/${encodeURIComponent(id)}`)
  }

  // Authorized apps: apps whose installs register themselves with App Attest.
  async getAuthorizedApps(): Promise<{ apps: AuthorizedAppWire[] }> {
    return this.get<{ apps: AuthorizedAppWire[] }>('/authorized-apps')
  }

  async getAuthorizedApp(id: string): Promise<AuthorizedAppWire> {
    return this.get<AuthorizedAppWire>(`/authorized-apps/${encodeURIComponent(id)}`)
  }

  async createAuthorizedApp(body: {
    name: string
    appleAppId: string
    planId: string
    allowDevelopment: boolean
  }): Promise<AuthorizedAppWire> {
    return this.post<AuthorizedAppWire>('/authorized-apps', body)
  }

  /** The app page's form, saved whole. The App ID is not editable. */
  async updateAuthorizedApp(
    id: string,
    body: { name: string; planId: string; allowDevelopment: boolean }
  ): Promise<AuthorizedAppWire> {
    return this.patch<AuthorizedAppWire>(`/authorized-apps/${encodeURIComponent(id)}`, body)
  }

  /** Off stops new installs and every token the app issued; on restores them. */
  async setAuthorizedAppEnabled(id: string, enabled: boolean): Promise<AuthorizedAppWire> {
    return this.post<AuthorizedAppWire>(
      `/authorized-apps/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      {}
    )
  }

  async getAppDevices(
    id: string,
    { query, offset, limit }: { query?: string; offset?: number; limit?: number } = {}
  ): Promise<{ total: number; devices: AppDeviceWire[] }> {
    const params = new URLSearchParams()
    if (query !== undefined && query.length > 0) params.set('q', query)
    if (offset !== undefined) params.set('offset', String(offset))
    if (limit !== undefined) params.set('limit', String(limit))
    const qs = params.toString()
    return this.get<{ total: number; devices: AppDeviceWire[] }>(
      `/authorized-apps/${encodeURIComponent(id)}/devices${qs.length > 0 ? `?${qs}` : ''}`
    )
  }

  // Identity for the shell footer. Verified upstream by adminAuth — a
  // forged Cf-Access-* header never reaches the handler.
  async getIdentity(): Promise<IdentityResponse> {
    return this.get<IdentityResponse>('/identity')
  }

  // Liveness. Served outside the API-key gate (it is a probe endpoint),
  // hence the absolute path rather than the /api base.
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch('/health', { headers: { Accept: 'application/json' } })
    return res.json()
  }
}

export const api = new ApiClient()

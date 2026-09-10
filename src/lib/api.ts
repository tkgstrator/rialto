import type {
  AccessTokenWire,
  HealthResponse,
  IdentityResponse,
  InboundSurfaceWire,
  InboundType,
  OverviewResponse,
  RequestLogItem,
  RouterPreferenceProfileWire,
  RouterPreferencesApplyResponse,
  RouterUtilizationResponse,
  RoutingMode,
  RoutingSchedulerStateResponse,
  SessionMessageItem,
  SessionSummary,
  SurfaceId,
  UpdateCheckResponse
} from '@/lib/api-types'
import type { Config } from '@/types'

// Every wire type lives in ./api-types and is re-exported here, so
// `@/lib/api` stays the one import path for both the client and the
// shapes it returns.
export type * from '@/lib/api-types'

// Browser-side API client. Fetches under `${baseUrl}<endpoint>` with the
// envelope APIKEY (mirrored onto X-API-Key) attached automatically. The
// temp key from `?tempApiKey=` lets the integrated `rialto ui` flow open the
// UI pre-authenticated without persisting the long-lived key.
class ApiClient {
  private baseUrl: string
  private apiKey: string
  private tempApiKey: string | null

  constructor(baseUrl: string = '/api', apiKey: string = '') {
    this.baseUrl = baseUrl
    this.apiKey = apiKey || localStorage.getItem('apiKey') || ''
    this.tempApiKey = new URLSearchParams(window.location.search).get('tempApiKey')
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey)
    } else {
      localStorage.removeItem('apiKey')
    }
  }

  private authHeader(): Record<string, string> {
    if (this.tempApiKey) return { 'X-Temp-API-Key': this.tempApiKey }
    if (this.apiKey) return { 'X-API-Key': this.apiKey }
    return {}
  }

  private async apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...this.authHeader(),
        ...options.headers
      }
    })

    if (response.status === 401) {
      // 401 invalidates the stored key. The event tells the shell to send
      // the operator to the login screen; the throw is what stops every
      // caller here.
      //
      // This used to `return new Promise(() => {})` — a promise that
      // never settles — on the theory that navigation would unmount the
      // caller anyway. It does not: a hanging promise means no `.catch`
      // and no `.finally` ever runs, so every screen that fetched sat on
      // its loading state forever with nothing on screen to explain why.
      localStorage.removeItem('apiKey')
      window.dispatchEvent(new CustomEvent('unauthorized'))
      throw new Error('Unauthorized')
    }

    if (!response.ok) {
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`
      try {
        const errorData = await response.json()
        if (errorData.error || errorData.message) {
          errorMessage = errorData.message || errorData.error || errorMessage
        }
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

  // Router preferences (Phase 6). The singleton preference chain that
  // the quota-aware router walks. GET is empty on a fresh DB, PUT
  // replaces the whole chain atomically.
  async getRouterPreferences(): Promise<RouterPreferenceProfileWire> {
    return this.get<RouterPreferenceProfileWire>('/router-preferences')
  }

  async putRouterPreferences(profile: RouterPreferenceProfileWire): Promise<RouterPreferencesApplyResponse> {
    return this.put<RouterPreferencesApplyResponse>('/router-preferences', profile)
  }

  // Router scheduler snapshot (Phase 5). Read-only. Cold-boot returns
  // an empty snapshot with tickAt=null so the UI renders "no data yet"
  // without a special path.
  async getRoutingSchedulerState(): Promise<RoutingSchedulerStateResponse> {
    return this.get<RoutingSchedulerStateResponse>('/routing-scheduler-state')
  }

  // Set a per-model manual tier override (Tier Editor). Send null to
  // clear and fall back to name inference. Reuses PATCH
  // /api/providers/{name}/models/{model}.
  async setModelTier(
    providerName: string,
    modelName: string,
    manualTier: 'fable' | 'opus' | 'sonnet' | 'haiku' | null
  ): Promise<{ success: boolean }> {
    return this.apiFetch<{ success: boolean }>(
      `/providers/${encodeURIComponent(providerName)}/models/${encodeURIComponent(modelName)}`,
      { method: 'PATCH', body: JSON.stringify({ manualTier }) }
    )
  }

  // Set a per-model reasoning-effort override. Send null to clear and
  // fall back to the vendor default. Reuses the same PATCH endpoint.
  async setModelReasoningEffort(
    providerName: string,
    modelName: string,
    reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  ): Promise<{ success: boolean }> {
    return this.apiFetch<{ success: boolean }>(
      `/providers/${encodeURIComponent(providerName)}/models/${encodeURIComponent(modelName)}`,
      { method: 'PATCH', body: JSON.stringify({ reasoningEffort }) }
    )
  }

  // Router utilization dashboard (Phase 7). Aggregations over the
  // requested window in hours (default 24).
  async getRouterUtilization(params?: { windowHours?: number }): Promise<RouterUtilizationResponse> {
    const q = new URLSearchParams()
    if (params?.windowHours != null) q.set('windowHours', String(params.windowHours))
    const qs = q.toString()
    return this.get<RouterUtilizationResponse>(`/router-utilization${qs ? `?${qs}` : ''}`)
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
  async getAccessTokens(): Promise<{ tokens: AccessTokenWire[] }> {
    return this.get<{ tokens: AccessTokenWire[] }>('/access-tokens')
  }

  async issueAccessToken(body: {
    name: string
    /** Omitted or empty issues a token that may call every surface. */
    surfaces?: SurfaceId[]
    profileKey?: string | null
    expiresAt?: string | null
  }): Promise<{ token: AccessTokenWire; plaintext: string }> {
    return this.post<{ token: AccessTokenWire; plaintext: string }>('/access-tokens', body)
  }

  async getAccessToken(id: string): Promise<AccessTokenWire> {
    return this.get<AccessTokenWire>(`/access-tokens/${encodeURIComponent(id)}`)
  }

  /**
   * Change what an existing token may do.
   *
   * Scope and profile only — the two things about a token that
   * legitimately change while the client keeps the same credential.
   */
  async updateAccessToken(
    id: string,
    body: { surfaces?: SurfaceId[]; profileKey?: string | null }
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

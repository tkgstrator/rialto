import type { Hono } from 'hono'
import { logger } from '../../logger'
import {
  CodexDevicePollRequestSchema,
  type CodexDevicePollResponse,
  type CodexDeviceStartResponse
} from '../../schemas/api/oauth'
import {
  exchangeCodexDeviceCode,
  pollCodexDeviceCode,
  requestCodexDeviceCode
} from '../../services/codex-auth/device-code'
import {
  createDeviceFlow,
  deleteDeviceFlow,
  getDeviceFlow,
  markDeviceFlowPolled,
  setDeviceFlowPhase
} from '../../services/codex-auth/device-flow-store'
import { connectCodexAccount } from '../../services/subscription-connect-service'
import { connectFailure } from './connect-failure'
import { requestedReauthenticationTarget } from './reauthentication-target'

export function registerDeviceRoutes(oauthRoute: Hono): void {
  // Start a Codex device-code sign-in: ask auth.openai.com for a one-time
  // code, hold the flow server-side, and hand the UI just enough to render
  // it and start polling. Codex only — no other vendor's CLI exposes this
  // device-auth endpoint set, and nothing here allows a `provider` param.
  oauthRoute.post('/api/oauth/device/start', async (c) => {
    try {
      const targetAccountId = await requestedReauthenticationTarget('codex', await c.req.json().catch(() => ({})))
      const code = await requestCodexDeviceCode()
      const { flowId, expiresAt } = createDeviceFlow(code, targetAccountId)
      return c.json({
        flowId,
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt,
        intervalSeconds: code.intervalSeconds
      } satisfies CodexDeviceStartResponse)
    } catch (err) {
      logger.error({ err }, '[oauth] codex device-code start failed')
      const failure = connectFailure(err, 'Failed to start Codex device-code sign-in.')
      return c.json(failure.body, failure.status === 400 ? 400 : 502)
    }
  })

  // One poll of an outstanding device-code flow. Client-driven: the UI times
  // this itself (see the countdown / interval it got from /start), and this
  // handler only forwards to auth.openai.com when the flow's own interval has
  // elapsed (device-flow-store.ts) — a tab polling too eagerly, or a second
  // tab on the same flow, answers from memory instead of doubling upstream
  // calls. `pending` / `connected` / `expired` are ordinary 200s; a hard
  // failure (bad flowId aside, which reads as `expired`) is the same 400/502
  // `{ success, error }` shape every other /api/oauth/* route answers with.
  oauthRoute.post('/api/oauth/device/poll', async (c) => {
    const body = await c.req.json<unknown>().catch(() => ({}))
    const parsed = CodexDevicePollRequestSchema.safeParse(body)
    if (!parsed.success) return c.json({ success: false as const, error: 'Missing `flowId`.' }, 400)

    const flow = getDeviceFlow(parsed.data.flowId)
    const expired: CodexDevicePollResponse = { status: 'expired' }
    const pending: CodexDevicePollResponse = { status: 'pending' }
    const connected: CodexDevicePollResponse = { status: 'connected' }
    if (flow === null) return c.json(expired)
    // Both answered from memory, before the expiry check: a sign-in that is
    // finishing or finished is not undone by the clock running out meanwhile.
    if (flow.phase === 'connected') return c.json(connected)
    if (flow.phase === 'completing') return c.json(pending)
    if (Date.now() >= flow.expiresAt) {
      deleteDeviceFlow(parsed.data.flowId)
      return c.json(expired)
    }
    if (Date.now() < flow.nextPollAt) return c.json(pending)

    // Claimed before the upstream call, not after: a poll that arrives while
    // this one is still waiting on auth.openai.com must answer `pending` from
    // memory. Otherwise both reach upstream, both can come back authorized,
    // and the second exchange of the single-use code fails the sign-in.
    markDeviceFlowPolled(parsed.data.flowId)
    const result = await pollCodexDeviceCode({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode })
    if (result.status === 'pending') return c.json(pending)
    if (result.status === 'error') {
      deleteDeviceFlow(parsed.data.flowId)
      return c.json({ success: false as const, error: result.message }, 502)
    }

    // Authorized. The exchange, the credential check and the first usage poll
    // take seconds, so the flow stays in the store as `completing` meanwhile
    // (see DeviceFlowPhase) instead of being dropped up front, where a poll
    // landing in those seconds found nothing and read `expired`.
    setDeviceFlowPhase(parsed.data.flowId, 'completing')
    try {
      const tokens = await exchangeCodexDeviceCode({ code: result.code, codeVerifier: result.codeVerifier })
      await connectCodexAccount(
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token
        },
        undefined,
        flow.targetAccountId
      )
      setDeviceFlowPhase(parsed.data.flowId, 'connected')
      return c.json(connected)
    } catch (err) {
      // The grant's code is single-use and spent, so there is nothing to retry
      // on this flow: the error goes back once and later polls read `expired`.
      deleteDeviceFlow(parsed.data.flowId)
      logger.error({ err }, '[oauth] codex device-code exchange failed')
      const failure = connectFailure(err, 'Failed to complete Codex device-code sign-in.')
      return c.json(failure.body, failure.status)
    }
  })
}

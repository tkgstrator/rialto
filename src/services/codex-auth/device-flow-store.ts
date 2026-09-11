/**
 * In-memory state for the Codex device-code flow — process-memory for
 * the same PoC-scope reason as oauth-flow-service.ts's pending-flow map,
 * but kept separate: this state is codex-only and outlives a single
 * request/callback round trip (a device code sits waiting for minutes,
 * polled repeatedly from the browser, rather than being consumed once).
 *
 * Client-driven polling: the browser calls POST /api/oauth/device/poll on
 * its own timer, but each call only reaches auth.openai.com when
 * `nextPollAt` has passed. That keeps a tab honouring an interval shorter
 * than the vendor's own, or a second tab open on the same flow, from
 * multiplying upstream polls — the flow's own pace governs regardless of
 * how often the client asks.
 */

import { randomBytes } from 'node:crypto'
import { CODEX_DEVICE_CODE_TTL_MS } from './device-code'

/**
 * `completing` covers the seconds between the vendor issuing a grant and the
 * account being stored (token exchange, credential check, first usage poll).
 * A poll landing then must read `pending`, not find the flow gone and tell
 * the operator their code expired while the sign-in is about to succeed.
 * `connected` is kept until the flow's own expiry so a later poll — a second
 * tab, a tick already on the wire — hears the same answer the first did.
 */
export type DeviceFlowPhase = 'polling' | 'completing' | 'connected'

export interface DeviceFlowState {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresAt: number
  nextPollAt: number
  phase: DeviceFlowPhase
}

const flows = new Map<string, DeviceFlowState>()

export const createDeviceFlow = (code: {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
}): { flowId: string; expiresAt: number } => {
  // A flow is only removed when a poll finds it finished or expired, so a
  // tab closed mid sign-in would leave its entry here for the life of the
  // process. Starting a new flow is the natural moment to drop those.
  const now = Date.now()
  for (const [id, flow] of flows) {
    // A flow mid-exchange is left to the request finishing it.
    if (now >= flow.expiresAt && flow.phase !== 'completing') flows.delete(id)
  }
  const flowId = randomBytes(24).toString('base64url')
  const expiresAt = now + CODEX_DEVICE_CODE_TTL_MS
  flows.set(flowId, {
    deviceAuthId: code.deviceAuthId,
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    intervalSeconds: code.intervalSeconds,
    expiresAt,
    // The first poll is allowed immediately — the interval only throttles
    // polls AFTER the vendor has answered once.
    nextPollAt: 0,
    phase: 'polling'
  })
  return { flowId, expiresAt }
}

export const getDeviceFlow = (flowId: string): DeviceFlowState | null => {
  const flow = flows.get(flowId)
  return flow === undefined ? null : flow
}

export const deleteDeviceFlow = (flowId: string): void => {
  flows.delete(flowId)
}

/** Record that an upstream poll just happened, so the next one waits out the interval. */
export const markDeviceFlowPolled = (flowId: string): void => {
  const flow = flows.get(flowId)
  if (!flow) return
  flows.set(flowId, { ...flow, nextPollAt: Date.now() + flow.intervalSeconds * 1000 })
}

export const setDeviceFlowPhase = (flowId: string, phase: DeviceFlowPhase): void => {
  const flow = flows.get(flowId)
  if (!flow) return
  flows.set(flowId, { ...flow, phase })
}

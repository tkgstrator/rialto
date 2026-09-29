/**
 * What every Codex MCP tool is handed, and the pieces they share.
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { noteTokenUse, type ResolvedToken } from '../../services/access-token-service'
import { admitRequest, hasAnyLimit } from '../../services/usage-window-service'
import { USAGE_LEDGER_UNAVAILABLE, windowLimitMessage } from '../usage-limit-message'

export interface ToolContext {
  /** The access token that opened /codex, already checked for the scope. */
  token: ResolvedToken
  /** The origin the caller reached this server on, for links it can open. */
  origin: string
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

export const textResult = (...texts: string[]): CallToolResult => ({
  content: texts.map((text) => ({ type: 'text' as const, text }))
})

export const errorResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true
})

/**
 * Count a tool call that spends a subscription against the token, and the
 * message that refuses it when one of its plan's usage windows is full.
 * Null when the call may proceed.
 *
 * The /v1 gate charges every request it admits. This server cannot: one
 * MCP session opens with `initialize`, a notification and `tools/list`
 * before any work is asked for, and a plan's allowance would be spent on
 * those. So the gate admits, and each tool that sends work to Codex
 * charges here — once per call, the same as one /v1 completion. Its
 * spend, if the model it reaches is priced, is added when the call's
 * usage is recorded, as on /v1.
 */
export async function chargeCall(token: ResolvedToken): Promise<string | null> {
  noteTokenUse(token.id)
  if (token.plan === null || !hasAnyLimit(token.plan.limits)) return null
  const admission = await admitRequest(token.id, token.plan.limits)
  if (admission.outcome === 'allowed') return null
  if (admission.outcome === 'exhausted') return windowLimitMessage(admission)
  return USAGE_LEDGER_UNAVAILABLE
}

const HEARTBEAT_MS = 15_000

/**
 * Run a slow call while telling the client, every 15 seconds, that it is
 * still going.
 *
 * A Codex answer at high effort, or an image, can take minutes, and an
 * HTTP response that stays silent that long does not survive the path to
 * the client: Bun closes an idle socket after `idleTimeout` (255 s at
 * most) and Cloudflare gives up on a quiet origin after 100 s. The tool
 * result travels on an SSE stream whose headers are already sent, so a
 * notification on it is enough to keep both from timing out.
 *
 * A progress notification when the client asked for progress (it sent a
 * progress token), a log message otherwise — a client that did not ask
 * for progress must not be sent it.
 */
export async function withHeartbeat<T>(
  extra: Pick<ToolExtra, '_meta' | 'sendNotification'>,
  label: string,
  run: () => Promise<T>,
  intervalMs = HEARTBEAT_MS
): Promise<T> {
  const started = Date.now()
  const progressToken = extra._meta?.progressToken
  const beat = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000)
    const message = `${label} (${seconds}s)`
    const notification: ServerNotification =
      progressToken !== undefined
        ? { method: 'notifications/progress', params: { progressToken, progress: seconds, message } }
        : { method: 'notifications/message', params: { level: 'info', logger: 'codex', data: message } }
    extra.sendNotification(notification).catch(() => {
      // The stream is gone; the call's own result will fail to send too,
      // and there is nobody left to tell.
    })
  }, intervalMs)
  try {
    return await run()
  } finally {
    clearInterval(beat)
  }
}

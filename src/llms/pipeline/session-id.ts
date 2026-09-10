/**
 * Session-id resolution shared by the provider-send and usage-extraction
 * modules (usage rows and message-capture rows must agree on the same
 * session id for a given request).
 *
 * Order of preference:
 *   1. `thread_id` header
 *   2. `x-claude-code-session-id` header
 *   3. the session id inside the request body's `metadata.user_id`
 *      (Claude Code sends it there as a JSON blob, or the legacy
 *      "<user>_session_<id>" form)
 *   4. a single random id minted once per request and reused for every
 *      recording — without this, the three resolveSessionId calls for one
 *      request (user turn, usage row, assistant turn) each got a fresh
 *      random id and scattered across three separate sessions.
 */

import { randomUUID } from 'node:crypto'
import type { TransformerContext } from '@/schemas/domain/pipeline'

// Per-request cache for the random fallback, so every recording of one
// request shares an id. Keyed on the (stable, per-request) context object;
// WeakMap lets entries GC with the request.
const randomSessionByContext = new WeakMap<object, string>()

// Pull the Claude Code session id out of the request body's
// `metadata.user_id`. Real Claude Code sends it as a JSON string
// `{ device_id, account_uuid, session_id }`; older traffic used the
// "<user>_session_<id>" shape. Returns undefined when neither is present.
function sessionFromBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const metadata = Reflect.get(body, 'metadata')
  if (metadata === null || typeof metadata !== 'object') return undefined
  const userId = Reflect.get(metadata, 'user_id')
  if (typeof userId !== 'string' || userId.length === 0) return undefined
  const parts = userId.split('_session_')
  if (parts.length > 1 && parts[1].length > 0) return parts[1]
  if (userId.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(userId)
      const sid = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'session_id') : undefined
      if (typeof sid === 'string' && sid.length > 0) return sid
    } catch {
      // user_id is not JSON — fall through to the random fallback.
    }
  }
  return undefined
}

/**
 * The session id the request carries on its own — headers first, then
 * the body — or undefined when it carries none.
 *
 * Split out of `resolveSessionId` because the /v1 route layer asks the
 * same question before any TransformerContext exists — it needs the
 * carried id on its own, without the random per-context fallback, which
 * would answer a different string on every call.
 */
export function sessionIdFromRequest(headers: Record<string, string> | undefined, body: unknown): string | undefined {
  const h = headers !== undefined ? headers : {}
  const threadId = typeof h.thread_id === 'string' ? h.thread_id : undefined
  if (threadId) return threadId
  const ccSession = typeof h['x-claude-code-session-id'] === 'string' ? h['x-claude-code-session-id'] : undefined
  if (ccSession) return ccSession
  return sessionFromBody(body)
}

export function resolveSessionId(context: TransformerContext): string {
  const carried = sessionIdFromRequest(context.req?.headers, context.req?.body)
  if (carried) return carried
  const cached = randomSessionByContext.get(context)
  if (cached) return cached
  const fresh = randomUUID()
  randomSessionByContext.set(context, fresh)
  return fresh
}

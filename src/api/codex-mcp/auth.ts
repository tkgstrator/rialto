import type { MiddlewareHandler } from 'hono'
import { resolveAccessToken } from '../../services/access-token-service'
import { CODEX_MCP_SCOPE } from '../../shared/codex-mcp'
import '../context'

const UNAUTHORIZED =
  'Invalid, revoked or expired access token. Issue one with the /codex scope on the Access tokens page and send it as Authorization: Bearer <token>.'

const NOT_SCOPED =
  'This access token does not have the /codex scope. Add it on the Access tokens page — a token with no scope does not include it.'

// A JSON-RPC error with no id: what an MCP client can show for a request
// the transport never saw.
const refusal = (message: string) => ({ jsonrpc: '2.0' as const, error: { code: -32001, message }, id: null })

/**
 * Gate for /codex, the Codex MCP server.
 *
 * Issued access tokens, as on /v1, with three differences:
 *
 * - Bearer only. That is the one header every MCP client can be told to
 *   send; there is no SDK convention here to match.
 * - The scope is opt-in. /v1 reads an empty scope as "every surface";
 *   here the token has to name `codex-mcp`, because `status` reports the
 *   operator's accounts, which a token issued for a client or an app must
 *   not read by default (src/shared/codex-mcp.ts).
 * - Nothing is counted here. The daily cap and the token's use count are
 *   charged by the tools that do work (tool-context.ts `chargeCall`), not
 *   by the handshake an MCP client performs before it asks for any.
 *
 * The 401 names no OAuth metadata: there is no authorization server
 * behind this, and pointing a client at one would start a sign-in that
 * cannot succeed instead of showing this message.
 */
export const codexMcpAuth: MiddlewareHandler = async (c, next) => {
  const presented = c.req.header('authorization')
  const secret = presented === undefined ? '' : presented.replace(/^Bearer\s+/i, '').trim()
  const token = secret.length === 0 ? null : await resolveAccessToken(secret)
  if (token === null) return c.json(refusal(UNAUTHORIZED), 401)
  if (!token.surfaces.includes(CODEX_MCP_SCOPE)) return c.json(refusal(NOT_SCOPED), 403)
  c.set('accessToken', token)
  return next()
}

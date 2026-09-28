/**
 * The Codex MCP server, at /codex.
 *
 * Streamable HTTP in stateless mode: every POST carries one JSON-RPC
 * message and is answered on its own, with a fresh server built from the
 * caller's token. Nothing is kept between requests except what the tools
 * keep on purpose (threads.ts, files.ts).
 *
 * The path, the stateless transport, CORS ahead of auth and the protocol
 * version clamp follow the other MCP servers published on mcp.qleap.jp
 * (suumo-mcp, local-mcp), so /codex can sit beside them at the edge
 * unchanged. docs/guides/codex-mcp.md covers publishing it.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { CODEX_MCP_PATH } from '../../shared/codex-mcp'
import { codexMcpAuth } from './auth'
import { extensionFor, getFile } from './files'
import { createCodexMcpServer } from './server'
import '../context'

export const codexMcpRoute = new Hono()

/**
 * A browser-hosted MCP client (the MCP Inspector, a web connector) sends
 * an OPTIONS preflight first, and never sends the real request if that is
 * refused. So CORS runs before the gate: a preflight carries no token.
 */
const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
  exposeHeaders: ['Mcp-Session-Id'],
  maxAge: 86400
})

/**
 * Read a protocol version the SDK does not know as the default it does.
 *
 * The SDK refuses any MCP-Protocol-Version outside its list, and clients
 * adopt new revisions before the SDK ships them — suumo-mcp lost every
 * ChatGPT connection to exactly this. What this server uses (initialize,
 * tools) has not changed between revisions, so accepting beats refusing.
 */
const clampProtocolVersion: MiddlewareHandler = async (c, next) => {
  const version = c.req.header('mcp-protocol-version')
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    const headers = new Headers(c.req.raw.headers)
    headers.set('mcp-protocol-version', DEFAULT_NEGOTIATED_PROTOCOL_VERSION)
    c.req.raw = new Request(c.req.raw, { headers })
  }
  await next()
}

/**
 * Where the caller reached this server, for links it will open itself.
 *
 * Behind Cloudflare the request arrives over plain HTTP, so the scheme is
 * read from X-Forwarded-Proto; a front that rewrites the host (the Worker
 * serving mcp.qleap.jp) can name the public one in X-Forwarded-Host. A
 * forged value only changes the link handed back to the caller who sent it.
 */
function publicOrigin(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')
  const forwardedHost = c.req.header('x-forwarded-host')
  const host = forwardedHost === undefined ? '' : forwardedHost.split(',')[0].trim()
  const scheme = proto === 'https' || proto === 'http' ? proto : url.protocol.slice(0, -1)
  return `${scheme}://${/^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? host : url.host}`
}

codexMcpRoute.use(CODEX_MCP_PATH, mcpCors, clampProtocolVersion)

codexMcpRoute.post(CODEX_MCP_PATH, codexMcpAuth, async (c) => {
  const server = createCodexMcpServer({ token: c.get('accessToken'), origin: publicOrigin(c) })
  // No session id generator: stateless mode, which is also what the
  // 2026-07-28 revision of the protocol settled on.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

// Stateless: there is no standalone stream to open with GET and no session
// to end with DELETE. 405 is how the transport spec says so; a client then
// carries on over POST alone.
codexMcpRoute.on(['GET', 'DELETE'], CODEX_MCP_PATH, (c) =>
  c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, {
    Allow: 'POST'
  })
)

/**
 * A generated image, for the agent that asked for it to save.
 *
 * Deliberately outside the gate: the key is the credential (files.ts).
 * Never cached or indexed, and always a download, never rendered in place.
 */
codexMcpRoute.get(`${CODEX_MCP_PATH}/files/:key`, (c) => {
  const file = getFile(c.req.param('key'))
  if (file === null) return c.text('This file has expired or never existed.', 404)
  return c.body(Buffer.from(file.bytes), 200, {
    'content-type': file.mimeType,
    'content-disposition': `attachment; filename="codex-image.${extensionFor(file.mimeType)}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow'
  })
})

/**
 * The Codex MCP server at `/codex`, as the SPA and the server both name it.
 *
 * It is an entry point but not an inbound surface: nothing about it is
 * routed, it speaks MCP rather than a vendor wire format, and every call it
 * makes is pinned to the Codex subscription. So it never appears in
 * `INBOUND_SURFACES` or gets an `InboundSurfaceConfig` row. It still
 * shows up in the two places a surface id does:
 *
 * - A token scope. Unlike a surface it is opt-in: an unscoped token (an
 *   empty list, "every surface") does not reach it, because the server
 *   reports the operator's Codex accounts and their quota, which a token
 *   issued for a client should not be able to read by default.
 * - `RequestLog.surface`, so a completion Codex answered through MCP is
 *   told apart from one a client sent to `/v1/responses` itself.
 */
export const CODEX_MCP_SCOPE = 'codex-mcp'

export const CODEX_MCP_PATH = '/codex'

export const CODEX_MCP_CLIENT = 'Codex MCP'

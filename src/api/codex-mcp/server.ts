import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { APP_VERSION } from '../../version'
import { registerAskTool } from './ask'
import { registerGenerateImageTool } from './generate-image'
import { registerStatusTool } from './status'
import type { ToolContext } from './tool-context'

// What the client shows the model before any tool is called. The tool
// names are generic (a client prefixes them with the server's name), so
// this is where "these are Codex" is said once.
const INSTRUCTIONS = [
  "This server is Codex — OpenAI's GPT-5 models, reached through the operator's ChatGPT subscription.",
  'Use `ask` for a second opinion from a different model family: code review, design critique, debugging.',
  'Codex sees only what you send it; it cannot read your files or run commands.',
  'Use `generate_image` for images, and `status` for remaining quota and the available models.'
].join(' ')

/**
 * One server per request.
 *
 * The transport is stateless — every POST is answered on its own — and the
 * tools close over the caller's token, so nothing is shared between
 * requests and a server cannot outlive the request that built it.
 */
export function createCodexMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'codex', version: APP_VERSION },
    // `logging` so a long call can keep its stream alive with a log line
    // when the client did not ask for progress (tool-context.ts).
    { capabilities: { logging: {} }, instructions: INSTRUCTIONS }
  )
  registerAskTool(server, ctx)
  registerGenerateImageTool(server, ctx)
  registerStatusTool(server, ctx)
  return server
}

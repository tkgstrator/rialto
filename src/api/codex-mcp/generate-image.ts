/**
 * `generate_image` — an image from Codex's image models.
 *
 * Generated through the same function `/v1/images/generations` uses, so
 * target resolution, the images surface's passthrough denials, account
 * rotation and the request log are shared; the log row is recorded under
 * the `codex-mcp` surface.
 *
 * The result carries the image twice: inline, so the calling model can
 * look at it, and as a short-lived link, so the calling agent can save it
 * (files.ts says why the link is needed).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { CODEX_MCP_PATH, CODEX_MCP_SCOPE } from '../../shared/codex-mcp'
import { generateImage } from '../v1/images'
import { extensionFor, FILE_TTL_MS, putFile, sniffImageType } from './files'
import { planAllows, resolveCodexTarget, targetId } from './targets'
import { chargeCall, errorResult, type ToolContext, withHeartbeat } from './tool-context'

const ImageArgs = {
  prompt: z.string().nonempty().max(32_000).describe('What to draw.'),
  model: z
    .string()
    .nonempty()
    .optional()
    .describe('Codex image model, as the `status` tool lists it. Omit for the newest enabled one.'),
  size: z.enum(['auto', '1024x1024', '1024x1536', '1536x1024']).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  include_image: z
    .boolean()
    .default(true)
    .describe('Return the image itself so you can see it. False returns only the download link, a much smaller result.')
}

type ImageArgsInput = {
  prompt: string
  model?: string
  size?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
  quality?: 'auto' | 'low' | 'medium' | 'high'
  background?: 'auto' | 'opaque' | 'transparent'
  include_image: boolean
}

const DESCRIPTION = [
  "Generate an image with Codex's image models (on the operator's ChatGPT subscription).",
  '',
  'Returns the image so you can check it, and a download link valid for 15 minutes that needs no',
  'credentials. To keep the image, download the link to a file (e.g. `curl -fsSL -o out.png <url>`);',
  'you cannot save the inline image yourself.'
].join('\n')

// An upstream error body is JSON or text; either way it is read, not rendered.
const describe = (message: unknown): string => (typeof message === 'string' ? message : JSON.stringify(message))

export async function generateImageTool(
  ctx: ToolContext,
  args: ImageArgsInput,
  run: <T>(f: () => Promise<T>) => Promise<T>
): Promise<CallToolResult> {
  const resolved = await resolveCodexTarget('image', args.model)
  if (!resolved.ok) return errorResult(resolved.message)
  const target = resolved.target
  if (!planAllows(ctx.token.plan, target)) {
    return errorResult(`This access token's plan does not include ${targetId(target)}.`)
  }
  const refusal = await chargeCall(ctx.token)
  if (refusal !== null) return errorResult(refusal)

  const outcome = await run(() =>
    generateImage(
      {
        model: targetId(target),
        prompt: args.prompt,
        ...(args.size === undefined ? {} : { size: args.size }),
        ...(args.quality === undefined ? {} : { quality: args.quality }),
        ...(args.background === undefined ? {} : { background: args.background })
      },
      { accessTokenId: ctx.token.id, surface: CODEX_MCP_SCOPE }
    )
  )
  if (!outcome.ok) return errorResult(`Image generation failed (HTTP ${outcome.status}): ${describe(outcome.message)}`)

  const bytes = Buffer.from(outcome.b64, 'base64')
  const mimeType = sniffImageType(bytes)
  const url = `${ctx.origin}${CODEX_MCP_PATH}/files/${putFile(bytes, mimeType)}`
  const minutes = FILE_TTL_MS / 60_000
  const link = [
    `Download link (valid ${minutes} minutes, no credentials needed): ${url}`,
    `Save it with: curl -fsSL -o image.${extensionFor(mimeType)} '${url}'`,
    `model: ${targetId(target)}`
  ].join('\n')
  return {
    content: [
      ...(args.include_image ? [{ type: 'image' as const, data: outcome.b64, mimeType }] : []),
      { type: 'text', text: link }
    ]
  }
}

export function registerGenerateImageTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image with Codex',
      description: DESCRIPTION,
      inputSchema: ImageArgs,
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async (args, extra) => generateImageTool(ctx, args, (f) => withHeartbeat(extra, 'Codex is still drawing', f))
  )
}

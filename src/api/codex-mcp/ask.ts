/**
 * `ask` — a second opinion from Codex.
 *
 * The call goes through the same /v1/responses handler a Codex CLI client
 * would reach, in process, so it gets everything that handler does: the
 * Codex OAuth transformer, account rotation on 429, the SSE fold back to
 * one JSON answer, and a request-log row. Three things are set on the way
 * in that a client could not set for itself:
 *
 * - The token's routing profile is forced to passthrough. Routed mode on
 *   /v1/responses may send a request to another provider; an answer that
 *   says it is Codex's must be Codex's.
 * - The token's plan is dropped for the same reason: a plan swaps a model
 *   it does not list for its default. The plan is checked before the call
 *   instead, and refuses (targets.ts `planAllows`).
 * - The request is recorded under the `codex-mcp` surface, not
 *   `openai-responses`, so Activity can tell it from Codex CLI traffic.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ResolvedToken } from '../../services/access-token-service'
import { PASSTHROUGH_PROFILE_KEY } from '../../services/tier-route-service'
import { CODEX_MCP_SCOPE } from '../../shared/codex-mcp'
import { REASONING_EFFORTS } from '../../shared/model-reasoning-effort'
import { v1Route } from '../v1/route'
import { planAllows, resolveCodexTarget, targetId } from './targets'
import { newThreadId, readThread, saveThread, type Turn } from './threads'
import { chargeCall, errorResult, type ToolContext, textResult, withHeartbeat } from './tool-context'
import '../context'

const AskInput = {
  prompt: z
    .string()
    .nonempty()
    .max(1_000_000)
    .describe(
      'What to ask. Codex cannot see your files or run commands: include the code, diff, error output or design it should look at.'
    ),
  thread_id: z
    .uuid()
    .optional()
    .describe('Continue an earlier conversation: the thread_id a previous ask returned. Omit to start a new one.'),
  model: z
    .string()
    .nonempty()
    .optional()
    .describe('Codex model, e.g. "gpt-5.5". Omit for the default. The `status` tool lists what is enabled.'),
  reasoning_effort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .describe('How hard Codex should think. Higher is slower. Omit for the model default.'),
  instructions: z
    .string()
    .nonempty()
    .max(100_000)
    .optional()
    .describe(
      'System instructions for Codex, e.g. the reviewer role to take. Kept for the rest of the thread unless replaced.'
    )
}

const DESCRIPTION = [
  "Ask Codex (OpenAI's GPT-5 models, on the operator's ChatGPT subscription) for a second opinion:",
  'a code review, a design critique, a bug hunt, a check of your reasoning.',
  '',
  'Codex sees only what you send. It cannot read your repository or run anything, so put the code,',
  'the diff or the context it needs into `prompt`.',
  '',
  'Every answer ends with a thread_id. Pass it back to ask a follow-up in the same conversation;',
  'threads are kept for 24 hours.'
].join('\n')

/** Run one Responses request through /v1 in process, as `token`, recorded as Codex MCP traffic. */
async function callResponses(token: ResolvedToken, threadId: string, body: Record<string, unknown>): Promise<Response> {
  const app = new Hono()
  app.use('*', async (c, next) => {
    // A copy: the token resolver caches the original object.
    c.set('accessToken', { ...token, profileKey: PASSTHROUGH_PROFILE_KEY, plan: null })
    c.set('surfaceOverride', CODEX_MCP_SCOPE)
    await next()
  })
  app.route('/', v1Route)
  return app.request('/v1/responses', {
    method: 'POST',
    // `thread_id` is the session header Codex CLI sends. It groups the
    // thread's turns into one session in Activity, keeps them on one
    // Codex account, and is passed on to the backend as its session.
    headers: { 'content-type': 'application/json', thread_id: threadId },
    body: JSON.stringify(body)
  })
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The answer's text: every output_text block of every message item, in order. */
export function outputText(payload: unknown): string {
  const output = isRecord(payload) ? payload.output : undefined
  if (!Array.isArray(output)) return ''
  return output
    .filter((item) => isRecord(item) && item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
    .filter((block) => isRecord(block) && block.type === 'output_text' && typeof block.text === 'string')
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/** The message of an OpenAI-shaped error envelope, or the raw body. */
function errorMessage(payload: unknown, raw: string): string {
  const error = isRecord(payload) ? payload.error : undefined
  const message = isRecord(error) ? error.message : undefined
  return typeof message === 'string' && message.length > 0 ? message : raw.slice(0, 2000)
}

type AskArgs = {
  prompt: string
  thread_id?: string
  model?: string
  reasoning_effort?: (typeof REASONING_EFFORTS)[number]
  instructions?: string
}

export async function ask(ctx: ToolContext, args: AskArgs, run: <T>(f: () => Promise<T>) => Promise<T>) {
  const previous = args.thread_id === undefined ? null : readThread(args.thread_id, ctx.token.id)
  if (args.thread_id !== undefined && previous === null) {
    return errorResult(
      'Unknown or expired thread_id. Threads last 24 hours and do not survive a Rialto restart; ask again without thread_id to start a new one.'
    )
  }
  const resolved = await resolveCodexTarget('completion', args.model)
  if (!resolved.ok) return errorResult(resolved.message)
  const target = resolved.target
  if (!planAllows(ctx.token.plan, target)) {
    return errorResult(`This access token's plan does not include ${targetId(target)}.`)
  }
  const refusal = await chargeCall(ctx.token)
  if (refusal !== null) return errorResult(refusal)

  const instructions = args.instructions !== undefined ? args.instructions : previous?.instructions
  const history: Turn[] = previous === null ? [] : previous.turns
  const turns: Turn[] = [...history, { role: 'user', text: args.prompt }]
  const threadId = args.thread_id !== undefined ? args.thread_id : newThreadId()
  const body = {
    model: targetId(target),
    input: turns.map((t) => ({ role: t.role, content: t.text })),
    ...(instructions === undefined ? {} : { instructions }),
    ...(args.reasoning_effort === undefined ? {} : { reasoning: { effort: args.reasoning_effort } }),
    stream: false
  }

  const res = await run(() => callResponses(ctx.token, threadId, body))
  const raw = await res.text()
  const payload: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })()
  if (!res.ok) {
    const hint = res.status === 429 ? ' Every Codex account may be rate limited; `status` shows when each resets.' : ''
    return errorResult(`Codex returned HTTP ${res.status}: ${errorMessage(payload, raw)}${hint}`)
  }
  const answer = outputText(payload)
  if (answer.length === 0) return errorResult('Codex returned no text.')

  saveThread(threadId, ctx.token.id, instructions, [...turns, { role: 'assistant', text: answer }])
  return textResult(answer, `thread_id: ${threadId}\nmodel: ${targetId(target)}`)
}

export function registerAskTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ask',
    {
      title: 'Ask Codex',
      description: DESCRIPTION,
      inputSchema: AskInput,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async (args, extra): Promise<CallToolResult> =>
      ask(ctx, args, (f) => withHeartbeat(extra, 'Codex is still thinking', f))
  )
}

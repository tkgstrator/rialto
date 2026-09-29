import { randomUUID } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { getPrismaClient } from '../../db/client'
import { AuthMode } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { fetchProvider } from '../../llms/provider-fetch'
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../../llms/transformers/openai/codex-oauth'
import { logger } from '../../logger'
import { ensureFreshCodexAccessToken } from '../../services/codex-auth/token'
import { clearAccountExhaustion, markAccountExhausted } from '../../services/failover-state'
import { passthroughDenial } from '../../services/inbound-surface-service'
import { releaseAccountForSession, resolveAccountForSession } from '../../services/session-account-router'
import { getSubAccountTokensForProvider } from '../../services/subscription-account-sync-service'
import { recordCallSpend } from '../../services/usage-window-service'
import type { CODEX_MCP_SCOPE } from '../../shared/codex-mcp'
import { CODEX_IMAGE_MODELS } from '../../shared/data/subscriptions'
import { buildErrorEnvelope } from './error-shape'
import '../context'

const MAX_BODY_BYTES = 128 * 1024
const MAX_ROTATIONS = 10
// The surface whose passthrough denials an image target is checked
// against. The Codex MCP server generates through here too, and a target
// the operator denied on the images surface stays denied there.
const IMAGE_PATH = '/v1/images/generations'
const ImageBody = z
  .object({
    model: z.string().nonempty(),
    prompt: z.string().nonempty().max(32_000),
    size: z.enum(['auto', '1024x1024', '1024x1536', '1536x1024']).optional(),
    quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
    background: z.enum(['auto', 'opaque', 'transparent']).optional(),
    n: z.literal(1).optional(),
    response_format: z.literal('b64_json').optional()
  })
  .strict()
export type ImageInput = z.infer<typeof ImageBody>

/**
 * Who asked for an image, as the request log records it. `surface` is the
 * entry point the caller used — the images surface itself, or the Codex
 * MCP server generating on a caller's behalf.
 */
export interface ImageCaller {
  accessTokenId: string
  surface: 'openai-images' | typeof CODEX_MCP_SCOPE
}

type ImageFailure = { ok: false; status: number; message: unknown; via?: string; retryAfter?: string }

/** A generated image, or the status and message it was refused with. */
export type ImageOutcome = { ok: true; payload: Record<string, unknown>; b64: string } | ImageFailure

const failure = (status: number, message: unknown, via?: string): ImageFailure => ({
  ok: false,
  status,
  message,
  ...(via === undefined ? {} : { via })
})

const fail = (c: Context, status: number, message: unknown, via?: string): Response => {
  const headers = new Headers(c.res.headers)
  headers.set('content-type', 'application/json')
  if (via !== undefined) headers.set('x-rialto-upstream', via)
  return new Response(JSON.stringify(buildErrorEnvelope({ shape: 'openai', status, from: message, via })), {
    status,
    headers
  })
}

/** Refuse ambiguous bare ids rather than charging the wrong subscription. */
export async function resolveImageTarget(model: string) {
  const comma = model.indexOf(',')
  const name = comma < 0 ? model : model.slice(comma + 1)
  if (!CODEX_IMAGE_MODELS.includes(name)) return null
  const rows = await getPrismaClient().model.findMany({
    where: {
      name,
      enabled: true,
      provider: {
        enabled: true,
        authMode: AuthMode.subscription,
        apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
        ...(comma < 0 ? {} : { name: model.slice(0, comma) })
      }
    },
    select: { provider: { select: { name: true, apiBaseUrl: true } } }
  })
  return rows.length === 1 ? { provider: rows[0].provider, model: name } : null
}

async function readImageInput(c: Context): Promise<ImageInput | null> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return null
  const length = Number(c.req.header('content-length'))
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null
  const reader = c.req.raw.body?.getReader()
  if (reader === undefined) return null
  const chunks: Uint8Array[] = []
  const total = { bytes: 0 }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total.bytes += value.byteLength
    if (total.bytes > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks))
  try {
    const parsed = ImageBody.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function imageUrl(base: string): string | null {
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.pathname !== '/backend-api/codex')
      return null
    if (url.search || url.hash || url.username || url.password || url.port) return null
    return `${url.origin}${url.pathname}/images/generations`
  } catch {
    return null
  }
}

function usageOf(payload: Record<string, unknown>): { input: number; output: number } {
  const usage = payload.usage
  if (usage === null || typeof usage !== 'object') return { input: 0, output: 0 }
  const input = Reflect.get(usage, 'input_tokens')
  const output = Reflect.get(usage, 'output_tokens')
  return {
    input: typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : 0,
    output: typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? output : 0
  }
}

async function recordImageUsage(input: {
  sessionId: string
  provider: string
  model: string
  requestedModel: string
  subAccountId: string
  caller: ImageCaller
  durationMs: number
  usage: { input: number; output: number }
}): Promise<void> {
  // Priced into the token's usage windows before the capture switch is
  // read, for the same reason as on the completion path.
  await recordCallSpend({
    accessTokenId: input.caller.accessTokenId,
    provider: input.provider,
    model: input.model,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  })
  if (process.env.CAPTURE_REQUESTS === 'false') return
  const prisma = getPrismaClient()
  await prisma.session.upsert({
    where: { id: input.sessionId },
    create: { id: input.sessionId, inboundType: 'openai' },
    update: { updatedAt: dayjs().toDate(), archivedAt: null }
  })
  await prisma.requestLog.create({
    data: {
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      requestedModel: input.requestedModel,
      scenario: 'passthrough',
      isSubagent: false,
      inboundType: 'openai',
      surface: input.caller.surface,
      accessTokenId: input.caller.accessTokenId,
      subAccountId: input.subAccountId,
      inputTokens: input.usage.input,
      totalInputTokens: input.usage.input,
      outputTokens: input.usage.output,
      durationMs: input.durationMs,
      status: 200
    }
  })
}

function isImagePayload(raw: unknown): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') return false
  const data = Reflect.get(raw, 'data')
  return (
    Array.isArray(data) &&
    data.length === 1 &&
    data[0] !== null &&
    typeof data[0] === 'object' &&
    typeof Reflect.get(data[0], 'b64_json') === 'string' &&
    Reflect.get(data[0], 'b64_json').length > 0
  )
}

type ImageTarget = NonNullable<Awaited<ReturnType<typeof resolveImageTarget>>>
type ImageAccount = NonNullable<Awaited<ReturnType<typeof resolveAccountForSession>>>

const imageRequest = (body: ImageInput, model: string): Record<string, unknown> => ({
  model,
  prompt: body.prompt,
  ...(body.size === undefined ? {} : { size: body.size }),
  ...(body.quality === undefined ? {} : { quality: body.quality }),
  ...(body.background === undefined ? {} : { background: body.background }),
  ...(body.n === undefined ? {} : { n: body.n })
})

async function sendImage(url: string, body: ImageInput, target: ImageTarget, account: ImageAccount): Promise<Response> {
  const token = await ensureFreshCodexAccessToken(account)
  return fetchProvider(url, imageRequest(body, target.model), {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(account.accountId === null ? {} : { 'chatgpt-account-id': account.accountId }),
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      'x-client-request-id': randomUUID(),
      accept: 'application/json'
    },
    httpsProxy: process.env.PROXY_URL
  })
}

// isImagePayload has already checked that the one entry carries it.
const b64Of = (payload: Record<string, unknown>): string => {
  const data = Reflect.get(payload, 'data')
  const first: unknown = Array.isArray(data) ? data[0] : undefined
  const b64: unknown = first !== null && typeof first === 'object' ? Reflect.get(first, 'b64_json') : undefined
  return typeof b64 === 'string' ? b64 : ''
}

async function imageResult(
  upstream: Response,
  target: ImageTarget,
  body: ImageInput,
  account: ImageAccount,
  caller: ImageCaller,
  sessionId: string,
  started: number
): Promise<ImageOutcome> {
  if (!upstream.ok) {
    const raw = (await upstream.text()).slice(0, 4096)
    const detail: unknown = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    })()
    const retryAfter = upstream.status === 429 ? upstream.headers.get('retry-after') : null
    return {
      ...failure(upstream.status, detail, target.provider.name),
      ...(retryAfter === null ? {} : { retryAfter })
    }
  }
  const payload: unknown = await upstream.json().catch(() => null)
  if (!isImagePayload(payload))
    return failure(502, 'Upstream returned an invalid image response.', target.provider.name)
  clearAccountExhaustion(account.subAccountId)
  // Awaited but never thrown: a failed log write must not cost the caller
  // an image already generated (and charged) upstream.
  await recordImageUsage({
    sessionId,
    provider: target.provider.name,
    model: target.model,
    requestedModel: body.model,
    subAccountId: account.subAccountId,
    caller,
    durationMs: Date.now() - started,
    usage: usageOf(payload)
  }).catch((err) => logger.error({ err }, 'image request usage capture failed'))
  return { ok: true, payload, b64: b64Of(payload) }
}

// Only the delta-seconds form of Retry-After is honoured; anything else
// leaves the exhaustion mark on its default expiry.
function retryDeadline(upstream: Response): number | undefined {
  const retryAfter = upstream.headers.get('retry-after')
  const delay = retryAfter === null ? Number.NaN : Number(retryAfter)
  return Number.isFinite(delay) && delay > 0 ? Date.now() + delay * 1000 : undefined
}

async function dispatchImage(
  body: ImageInput,
  target: ImageTarget,
  url: string,
  caller: ImageCaller
): Promise<ImageOutcome> {
  const pool = await getSubAccountTokensForProvider(target.provider.name)
  if (pool === null || pool.codex.length === 0) return failure(503, 'No usable Codex subscription account.')
  const sessionId = randomUUID()
  const started = Date.now()
  const tried = new Set<string>()
  for (let rotation = 0; rotation < Math.min(pool.codex.length, MAX_ROTATIONS + 1); rotation++) {
    const account = await resolveAccountForSession(sessionId, 'codex', target.model, Date.now(), target.provider.name)
    if (account === null || tried.has(account.subAccountId)) break
    tried.add(account.subAccountId)
    try {
      const upstream = await sendImage(url, body, target, account)
      if (upstream.status !== 429) return imageResult(upstream, target, body, account, caller, sessionId, started)
      markAccountExhausted(account.subAccountId, retryDeadline(upstream))
      releaseAccountForSession(sessionId, account.subAccountId)
      if (tried.size >= pool.codex.length || rotation === MAX_ROTATIONS) {
        return imageResult(upstream, target, body, account, caller, sessionId, started)
      }
      await upstream.body?.cancel()
    } catch (err) {
      logger.error({ err, provider: target.provider.name, model: target.model }, 'image request failed')
      return failure(502, 'Codex image upstream is unavailable.', target.provider.name)
    }
  }
  return failure(429, 'All Codex subscription accounts are rate limited.', target.provider.name)
}

/**
 * Generate one image on a Codex subscription, rotating accounts on 429.
 *
 * The HTTP handler below and the Codex MCP server's `generate_image` tool
 * both come through here, so the target resolution, the passthrough
 * denials, the rotation and the request log are the same for both.
 */
export async function generateImage(body: ImageInput, caller: ImageCaller): Promise<ImageOutcome> {
  const target = await resolveImageTarget(body.model)
  if (target === null) return failure(400, 'Image model is unavailable, disabled, or ambiguous.')
  const denied = await passthroughDenial(IMAGE_PATH, `${target.provider.name},${target.model}`)
  if (denied !== undefined) return failure(403, denied)
  const url = imageUrl(target.provider.apiBaseUrl)
  if (url === null) return failure(400, 'Codex image endpoint is not configured.')
  return dispatchImage(body, target, url, caller)
}

export async function handleImageGeneration(c: Context): Promise<Response> {
  const body = await readImageInput(c)
  if (body === null)
    return fail(c, 400, 'Invalid image request (JSON, model, prompt, and supported image options required).')
  const outcome = await generateImage(body, { accessTokenId: c.get('accessToken').id, surface: 'openai-images' })
  if (outcome.ok) return c.json(outcome.payload)
  // Set before `fail`, which carries the context's headers onto its response.
  if (outcome.retryAfter !== undefined) c.header('retry-after', outcome.retryAfter)
  return fail(c, outcome.status, outcome.message, outcome.via)
}

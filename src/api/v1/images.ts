import { randomUUID } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { getPrismaClient } from '../../db/client'
import { AuthMode } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { fetchProvider } from '../../llms/provider-fetch'
import { CODEX_USER_AGENT } from '../../llms/transformers/openai/codex-oauth'
import { logger } from '../../logger'
import { ensureFreshCodexAccessToken } from '../../services/codex-auth/token'
import { clearAccountExhaustion, markAccountExhausted } from '../../services/failover-state'
import { passthroughDenial } from '../../services/inbound-surface-service'
import { releaseAccountForSession, resolveAccountForSession } from '../../services/session-account-router'
import { getSubAccountTokensForProvider } from '../../services/subscription-account-sync-service'
import { CODEX_IMAGE_MODELS } from '../../shared/data/subscriptions'
import { buildErrorEnvelope } from './error-shape'
import '../context'

const MAX_BODY_BYTES = 128 * 1024
const MAX_ROTATIONS = 10
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
type ImageInput = z.infer<typeof ImageBody>

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
  if (base !== 'https://chatgpt.com/backend-api/codex') return null
  return `${base}/images/generations`
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
  accessTokenId: string
  durationMs: number
  usage: { input: number; output: number }
}): Promise<void> {
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
      surface: 'openai-images',
      accessTokenId: input.accessTokenId,
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
      originator: 'codex_cli',
      'user-agent': CODEX_USER_AGENT,
      'x-client-request-id': randomUUID(),
      accept: 'application/json'
    },
    httpsProxy: process.env.PROXY_URL
  })
}

async function imageResult(
  c: Context,
  upstream: Response,
  target: ImageTarget,
  body: ImageInput,
  account: ImageAccount,
  sessionId: string,
  started: number
): Promise<Response> {
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter !== null) c.header('retry-after', retryAfter)
  }
  if (!upstream.ok) {
    const raw = (await upstream.text()).slice(0, 4096)
    const detail: unknown = (() => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    })()
    return fail(c, upstream.status, detail, target.provider.name)
  }
  const payload: unknown = await upstream.json().catch(() => null)
  if (!isImagePayload(payload))
    return fail(c, 502, 'Upstream returned an invalid image response.', target.provider.name)
  clearAccountExhaustion(account.subAccountId)
  // Awaited but never thrown: a failed log write must not cost the caller
  // an image already generated (and charged) upstream.
  await recordImageUsage({
    sessionId,
    provider: target.provider.name,
    model: target.model,
    requestedModel: body.model,
    subAccountId: account.subAccountId,
    accessTokenId: c.get('accessToken').id,
    durationMs: Date.now() - started,
    usage: usageOf(payload)
  }).catch((err) => logger.error({ err }, 'image request usage capture failed'))
  return c.json(payload)
}

// Only the delta-seconds form of Retry-After is honoured; anything else
// leaves the exhaustion mark on its default expiry.
function retryDeadline(upstream: Response): number | undefined {
  const retryAfter = upstream.headers.get('retry-after')
  const delay = retryAfter === null ? Number.NaN : Number(retryAfter)
  return Number.isFinite(delay) && delay > 0 ? Date.now() + delay * 1000 : undefined
}

async function dispatchImage(c: Context, body: ImageInput, target: ImageTarget, url: string): Promise<Response> {
  const pool = await getSubAccountTokensForProvider(target.provider.name)
  if (pool === null || pool.codex.length === 0) return fail(c, 503, 'No usable Codex subscription account.')
  const sessionId = randomUUID()
  const started = Date.now()
  const tried = new Set<string>()
  for (let rotation = 0; rotation < Math.min(pool.codex.length, MAX_ROTATIONS + 1); rotation++) {
    const account = await resolveAccountForSession(sessionId, 'codex', target.model, Date.now(), target.provider.name)
    if (account === null || tried.has(account.subAccountId)) break
    tried.add(account.subAccountId)
    try {
      const upstream = await sendImage(url, body, target, account)
      if (upstream.status !== 429) return imageResult(c, upstream, target, body, account, sessionId, started)
      markAccountExhausted(account.subAccountId, retryDeadline(upstream))
      releaseAccountForSession(sessionId, account.subAccountId)
      if (tried.size >= pool.codex.length || rotation === MAX_ROTATIONS) {
        return imageResult(c, upstream, target, body, account, sessionId, started)
      }
      await upstream.body?.cancel()
    } catch (err) {
      logger.error({ err, provider: target.provider.name, model: target.model }, 'image request failed')
      return fail(c, 502, 'Codex image upstream is unavailable.', target.provider.name)
    }
  }
  return fail(c, 429, 'All Codex subscription accounts are rate limited.', target.provider.name)
}

export async function handleImageGeneration(c: Context): Promise<Response> {
  const body = await readImageInput(c)
  if (body === null)
    return fail(c, 400, 'Invalid image request (JSON, model, prompt, and supported image options required).')
  const target = await resolveImageTarget(body.model)
  if (target === null) return fail(c, 400, 'Image model is unavailable, disabled, or ambiguous.')
  const denied = await passthroughDenial(c.req.path, `${target.provider.name},${target.model}`)
  if (denied !== undefined) return fail(c, 403, denied)
  const url = imageUrl(target.provider.apiBaseUrl)
  if (url === null) return fail(c, 400, 'Codex image endpoint is not configured.')
  return dispatchImage(c, body, target, url)
}

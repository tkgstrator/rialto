import { randomUUID } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { getPrismaClient } from '../../db/client'
import { AuthMode } from '../../generated/prisma/client'
import dayjs from '../../lib/dayjs'
import { IMAGE_EDIT_PATH } from '../../llms/inbound/surfaces'
import { fetchProvider } from '../../llms/provider-fetch'
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../../llms/transformers/openai/codex-oauth'
import { isSseContentType } from '../../llms/utils/sse-aggregate/parse'
import { logger } from '../../logger'
import type { TokenPlan } from '../../services/access-token-service'
import { ensureFreshCodexAccessToken } from '../../services/codex-auth/token'
import { clearAccountExhaustion, markAccountExhausted } from '../../services/failover-state'
import { passthroughDenial, resolveSurfaceForPath } from '../../services/inbound-surface-service'
import { decidePlanModel } from '../../services/plan-model'
import { releaseAccountForSession, resolveAccountForSession } from '../../services/session-account-router'
import { getSubAccountTokensForProvider } from '../../services/subscription-account-sync-service'
import { orderTokenProviders, tokenAllowsTarget } from '../../services/token-model-routing'
import { recordCallSpend } from '../../services/usage-window-service'
import { allowsProviderMode, allowsTokenModel, type TokenPolicy } from '../../shared/access-token-policy'
import type { CODEX_MCP_SCOPE } from '../../shared/codex-mcp'
import {
  isImageOnlyModel,
  isOpenAIImageModel,
  OPENAI_IMAGE_ENDPOINT,
  supportsImageModel
} from '../../shared/data/openai-images'
import { isCodexImageModel } from '../../shared/data/subscriptions'
import { readBoundedBody } from './bounded-body'
import { buildErrorEnvelope } from './error-shape'
import { relayImageEditStream } from './image-edit-stream'
import '../context'

const MAX_BODY_BYTES = 128 * 1024
const MAX_EDIT_BODY_BYTES = 50 * 1024 * 1024
const MAX_ROTATIONS = 10
// The surface whose passthrough denials an image target is checked
// against. The Codex MCP server generates through here too, and a target
// the operator denied on the images surface stays denied there.
const OPENAI_IMAGE_EDIT_ENDPOINT = `https://api.openai.com${IMAGE_EDIT_PATH}`
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
  plan?: TokenPlan | null
  policy?: TokenPolicy
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

async function resolveImageTargets(model: string, caller: ImageCaller, path: string) {
  const comma = model.indexOf(',')
  const name = model.slice(comma + 1)
  const rows = await getPrismaClient().model.findMany({
    where: {
      name,
      enabled: true,
      provider: {
        enabled: true,
        ...(path === IMAGE_EDIT_PATH ? { authMode: AuthMode.api_key } : {}),
        ...(comma < 0 ? {} : { name: model.slice(0, comma) })
      }
    },
    select: { provider: { select: { name: true, apiBaseUrl: true, apiKey: true, authMode: true } } }
  })
  const candidates = rows
    .map((row) => row.provider)
    .filter(
      (provider) =>
        supportsImageModel(provider, name) &&
        (caller.surface !== 'codex-mcp' || provider.authMode === AuthMode.subscription) &&
        tokenAllowsTarget(caller.plan, caller.policy, {
          provider: provider.name,
          model: name,
          authMode: provider.authMode
        })
    )
  const available = (
    await Promise.all(
      candidates.map(async (provider) => {
        if (provider.authMode === AuthMode.api_key) return provider.apiKey?.trim() ? provider : null
        const pool = await getSubAccountTokensForProvider(provider.name)
        return pool !== null && pool.codex.length > 0 ? provider : null
      })
    )
  ).filter((provider) => provider !== null)
  const surface = await resolveSurfaceForPath(path)
  const allowed = available.filter((provider) => !surface?.deniedTargets.includes(`${provider.name},${name}`))
  const order = await orderTokenProviders(
    name,
    allowed.map((provider) => ({ provider: provider.name, authMode: provider.authMode })),
    caller.plan,
    caller.policy
  )
  const targets =
    order.status === 'preferred'
      ? order.providers.flatMap((id) => {
          const provider = allowed.find((row) => row.name === id)
          return provider === undefined ? [] : [{ provider, model: name }]
        })
      : []
  const denial =
    allowed.length === 0 && available.length > 0
      ? await passthroughDenial(path, `${available[0].name},${name}`)
      : undefined
  return { targets, denial }
}

async function readImageInput(c: Context): Promise<ImageInput | null> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return null
  const bytes = await readBoundedBody(c, MAX_BODY_BYTES)
  if (bytes === null) return null
  const raw = new TextDecoder().decode(bytes)
  try {
    const parsed = ImageBody.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
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
  subAccountId: string | null
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
      reasoningEffort: null,
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

type ImageTarget = Awaited<ReturnType<typeof resolveImageTargets>>['targets'][number]
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
  body: { model: string },
  account: ImageAccount | null,
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
  if (account !== null) clearAccountExhaustion(account.subAccountId)
  // Awaited but never thrown: a failed log write must not cost the caller
  // an image already generated (and charged) upstream.
  await recordImageUsage({
    sessionId,
    provider: target.provider.name,
    model: target.model,
    requestedModel: body.model,
    subAccountId: account === null ? null : account.subAccountId,
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

async function dispatchOpenAIImage<T = never>(
  body: { model: string },
  target: ImageTarget,
  caller: ImageCaller,
  url: string,
  request: Record<string, unknown> | FormData,
  onStream?: (
    upstream: Response,
    stream: ReadableStream<Uint8Array>,
    completed: (event: Record<string, unknown>) => Promise<void>
  ) => T
): Promise<ImageOutcome | T> {
  const key = target.provider.apiKey?.trim()
  if (!key) return failure(503, 'No OpenAI API key configured.', target.provider.name)
  const started = Date.now()
  try {
    const upstream = await fetchProvider(url, request, {
      headers: {
        authorization: `Bearer ${key}`,
        accept: onStream === undefined ? 'application/json' : 'text/event-stream'
      },
      httpsProxy: process.env.PROXY_URL
    })
    const sessionId = randomUUID()
    if (upstream.ok && onStream !== undefined) {
      if (!isSseContentType(upstream.headers.get('content-type')) || upstream.body === null) {
        await upstream.body?.cancel()
        return failure(502, 'Upstream returned an invalid image edit stream.', target.provider.name)
      }
      return onStream(upstream, upstream.body, (event) =>
        recordImageUsage({
          sessionId,
          provider: target.provider.name,
          model: target.model,
          requestedModel: body.model,
          subAccountId: null,
          caller,
          durationMs: Date.now() - started,
          usage: usageOf(event)
        }).catch((err) => logger.error({ err }, 'image edit stream usage capture failed'))
      )
    }
    return await imageResult(upstream, target, body, null, caller, sessionId, started)
  } catch {
    return failure(502, 'OpenAI image upstream is unavailable.', target.provider.name)
  }
}

/**
 * Generate one image through OpenAI API credentials or a Codex subscription.
 *
 * The HTTP handler below and the Codex MCP server's `generate_image` tool
 * both come through here, so the target resolution, the passthrough
 * denials, the rotation and the request log are the same for both.
 */
export async function generateImage(body: ImageInput, caller: ImageCaller): Promise<ImageOutcome> {
  // The same plan check the completion surfaces apply: a model the plan does
  // not list is refused, not swapped for one it does. `model` is required by
  // the body schema, so a plan never falls back to its default here.
  const decision = decidePlanModel(caller.plan, body.model)
  if (decision.kind === 'denied') return failure(403, decision.message)
  const model = body.model.slice(body.model.indexOf(',') + 1)
  if (!allowsTokenModel(caller.policy, model)) return failure(403, 'Image model is not allowed for this token.')
  if (!isImageOnlyModel(model)) return failure(400, 'Image model is unavailable, disabled, or ambiguous.')
  const apiAllowed = isOpenAIImageModel(model) && allowsProviderMode(caller.policy, 'api_key')
  const subscriptionAllowed = isCodexImageModel(model) && allowsProviderMode(caller.policy, 'subscription')
  if (!apiAllowed && !subscriptionAllowed) return failure(403, 'Image provider is not allowed for this token.')
  const { targets, denial } = await resolveImageTargets(body.model, caller, IMAGE_PATH)
  if (denial !== undefined) return failure(403, denial)
  if (targets.length === 0) return failure(400, 'Image model is unavailable, disabled, or ambiguous.')

  const fallback = caller.policy?.providerMode.endsWith('_first') && caller.policy.providerFallback
  const result: { last: ImageOutcome } = { last: failure(503, 'No image provider is available.') }
  for (const target of targets) {
    const outcome =
      target.provider.authMode === AuthMode.api_key
        ? await dispatchOpenAIImage(body, target, caller, OPENAI_IMAGE_ENDPOINT, imageRequest(body, target.model))
        : await dispatchImage(body, target, `${target.provider.apiBaseUrl}/images/generations`, caller)
    if (outcome.ok || (outcome.status !== 429 && outcome.status !== 503)) return outcome
    // Preserve the existing image behavior unless the operator enabled provider fallback.
    if (!fallback) return outcome
    result.last = outcome
  }
  return result.last
}

export async function handleImageGeneration(c: Context): Promise<Response> {
  const body = await readImageInput(c)
  if (body === null)
    return fail(c, 400, 'Invalid image request (JSON, model, prompt, and supported image options required).')
  return imageResponse(c, await generateImage(body, imageCaller(c)))
}

function imageCaller(c: Context): ImageCaller {
  const token = c.get('accessToken')
  return { accessTokenId: token.id, surface: 'openai-images', plan: token.plan, policy: token.policy }
}

function imageResponse(c: Context, outcome: ImageOutcome): Response {
  if (outcome.ok) return c.json(outcome.payload)
  if (outcome.retryAfter !== undefined) c.header('retry-after', outcome.retryAfter)
  return fail(c, outcome.status, outcome.message, outcome.via)
}

const EditFields = ImageBody.pick({ model: true, prompt: true, n: true }).extend({
  stream: z.literal([true, false]).optional(),
  partial_images: z.number().int().min(0).max(3).optional()
})
const ImageReference = z.union([
  z.object({ file_id: z.string().nonempty() }).strict(),
  z.object({ image_url: z.string().nonempty() }).strict()
])
const EditJson = EditFields.extend({ images: z.array(ImageReference).min(1).max(16) }).loose()
type ImageEdit = { model: string; stream: boolean; request: Record<string, unknown> | FormData }

function multipartEdit(form: FormData): ImageEdit | null {
  if (['model', 'prompt', 'n', 'stream', 'partial_images'].some((field) => form.getAll(field).length > 1)) return null
  const stream = form.get('stream')
  if (stream !== null && stream !== 'true' && stream !== 'false') return null
  const partial = form.get('partial_images')
  if (partial !== null && (typeof partial !== 'string' || !/^[0-3]$/.test(partial))) return null
  const parsed = EditFields.safeParse({
    model: form.get('model'),
    prompt: form.get('prompt'),
    n: form.has('n') ? Number(form.get('n')) : undefined,
    stream: stream === null ? undefined : stream === 'true',
    partial_images: partial === null ? undefined : Number(partial)
  })
  const images = [...form.getAll('image'), ...form.getAll('image[]')]
  if (!parsed.success || images.length === 0 || images.length > 16) return null
  if (images.some((image) => typeof image === 'string' || image.size === 0)) return null
  return { model: parsed.data.model, stream: parsed.data.stream === true, request: form }
}

async function parseImageEdit(
  type: string,
  contentType: string,
  bytes: Uint8Array<ArrayBuffer>
): Promise<ImageEdit | null> {
  if (type === 'multipart/form-data') {
    const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
    return multipartEdit(form)
  }
  const parsed = EditJson.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
  return parsed.success ? { model: parsed.data.model, stream: parsed.data.stream === true, request: parsed.data } : null
}

function imageEditStreamResponse(
  upstream: Response,
  stream: ReadableStream<Uint8Array>,
  completed: (event: Record<string, unknown>) => Promise<void>
): Response {
  const headers = new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no'
  })
  return new Response(relayImageEditStream(stream, completed), { status: upstream.status, headers })
}

async function editImage(body: ImageEdit, caller: ImageCaller): Promise<ImageOutcome | Response> {
  const decision = decidePlanModel(caller.plan, body.model)
  if (decision.kind === 'denied') return failure(403, decision.message)
  const name = body.model.slice(body.model.indexOf(',') + 1)
  if (!allowsTokenModel(caller.policy, name)) return failure(403, 'Image model is not allowed for this token.')
  if (!isOpenAIImageModel(name)) return failure(400, 'Image editing requires a supported OpenAI API model.')
  if (!allowsProviderMode(caller.policy, 'api_key'))
    return failure(403, 'Image provider is not allowed for this token.')
  const { targets, denial } = await resolveImageTargets(body.model, caller, IMAGE_EDIT_PATH)
  if (denial !== undefined) return failure(403, denial)
  const [first] = targets
  if (first === undefined) return failure(400, 'Image model is unavailable, disabled, or ambiguous.')
  const request = body.request
  if (request instanceof FormData) request.set('model', first.model)
  const upstreamBody = request instanceof FormData ? request : { ...request, model: first.model }
  let outcome: ImageOutcome = failure(503, 'No image provider is available.')
  for (const target of targets) {
    const result = await dispatchOpenAIImage(
      body,
      target,
      caller,
      OPENAI_IMAGE_EDIT_ENDPOINT,
      upstreamBody,
      body.stream ? imageEditStreamResponse : undefined
    )
    if (result instanceof Response) return result
    outcome = result
    if (outcome.ok || (outcome.status !== 429 && outcome.status !== 503)) return outcome
    if (!caller.policy?.providerMode.endsWith('_first') || !caller.policy.providerFallback) return outcome
  }
  return outcome
}

export async function handleImageEdit(c: Context): Promise<Response> {
  const contentType = c.req.header('content-type')
  const type = contentType?.split(';')[0].trim().toLowerCase()
  if (contentType === undefined || (type !== 'application/json' && type !== 'multipart/form-data'))
    return fail(c, 400, 'Image edits require multipart/form-data or application/json.')
  const bytes = await readBoundedBody(c, MAX_EDIT_BODY_BYTES).catch(() => null)
  if (bytes === null) return fail(c, 413, 'Image edit request exceeds the 50 MiB limit.')
  const body = await parseImageEdit(type, contentType, bytes).catch(() => null)
  if (body === null) return fail(c, 400, 'Image edits require a model, prompt, and at least one input image.')
  const outcome = await editImage(body, imageCaller(c))
  return outcome instanceof Response ? outcome : imageResponse(c, outcome)
}

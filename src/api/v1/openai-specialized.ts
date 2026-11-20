import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { getPrismaClient } from '../../db/client'
import { DECISIONS_PATH } from '../../llms/inbound/surfaces'
import { fetchProvider } from '../../llms/provider-fetch'
import { logger } from '../../logger'
import { resolveSurfaceForPath } from '../../services/inbound-surface-service'
import { decidePlanModel } from '../../services/plan-model'
import { orderTokenProviders, tokenAllowsTarget } from '../../services/token-model-routing'
import { hasAnyLimit, recordCallSpend } from '../../services/usage-window-service'
import { allowsProviderMode, allowsTokenModel } from '../../shared/access-token-policy'
import { isOfficialOpenAIApiProvider } from '../../shared/data/openai-images'
import { windowLimitRefusal } from '../api-key-auth'
import { readBoundedBody } from './bounded-body'
import { buildErrorEnvelope } from './error-shape'

const SPEECH_PATH = '/v1/audio/speech'
const MAX_DECISIONS_BYTES = 32 * 1024 * 1024
const Body = z.object({ model: z.string().nonempty() }).loose()
type SpecializedBody = z.infer<typeof Body>
const modelName = (target: string): string => target.slice(target.indexOf(',') + 1)

const speechModels = new Set([
  'tts-1',
  'tts-1-hd',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-03-20',
  'gpt-4o-mini-tts-2025-12-15'
])
export const isOpenAISpeechModel = (target: string): boolean => speechModels.has(modelName(target))

export function readSpecializedBody(bytes: Uint8Array): SpecializedBody | null {
  try {
    const parsed = Body.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function fail(status: number, from: unknown): Response {
  return Response.json(buildErrorEnvelope({ shape: 'openai', status, from }), { status })
}

async function openAITargets(c: Context, path: string, body: SpecializedBody) {
  const token = c.get('accessToken')
  const model = modelName(body.model)
  const decision = decidePlanModel(token.plan, body.model)
  if (decision.kind === 'denied') return fail(403, decision.message)
  if (!allowsTokenModel(token.policy, model) || !allowsProviderMode(token.policy, 'api_key'))
    return fail(403, 'Model or provider is not allowed for this token.')

  const comma = body.model.indexOf(',')
  const rows = await getPrismaClient().model.findMany({
    where: {
      name: model,
      enabled: true,
      provider: { enabled: true, authMode: 'api_key', ...(comma < 0 ? {} : { name: body.model.slice(0, comma) }) }
    },
    select: { provider: { select: { name: true, apiBaseUrl: true, authMode: true, apiKey: true } } }
  })
  const surface = await resolveSurfaceForPath(path)
  const candidates = rows
    .map(({ provider }) => provider)
    .filter(
      (provider) =>
        isOfficialOpenAIApiProvider(provider) &&
        tokenAllowsTarget(token.plan, token.policy, { provider: provider.name, authMode: provider.authMode, model }) &&
        !surface?.deniedTargets.includes(`${provider.name},${model}`)
    )
  const credentials = candidates.flatMap(({ name, authMode, apiKey }) => {
    const key = apiKey?.trim()
    return key ? [{ provider: name, authMode, key }] : []
  })
  const order = await orderTokenProviders(model, credentials, token.plan, token.policy)
  if (order.status !== 'preferred') return fail(400, 'OpenAI model is unavailable, disabled, or ambiguous.')
  return order.providers.flatMap((name) => credentials.filter(({ provider }) => provider === name))
}

function relayResponse(upstream: Response): Response {
  const headers = new Headers()
  for (const name of ['content-type', 'content-disposition', 'cache-control', 'retry-after', 'x-request-id']) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

const Usage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional()
})

async function recordDecisionSpend(c: Context, upstream: Response, provider: string, model: string): Promise<void> {
  const payload: unknown = await upstream
    .clone()
    .json()
    .catch(() => null)
  if (payload === null || typeof payload !== 'object') return
  const usage = Usage.safeParse(Reflect.get(payload, 'usage'))
  if (!usage.success) return
  await recordCallSpend({
    accessTokenId: c.get('accessToken').id,
    provider,
    model,
    inputTokens: usage.data.input_tokens,
    outputTokens: usage.data.output_tokens,
    cacheReadTokens: usage.data.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  }).catch((err) => logger.warn({ err }, 'decision spend capture failed'))
}

async function relayOpenAI(c: Context, path: string, body: SpecializedBody): Promise<Response> {
  const targets = await openAITargets(c, path, body)
  if (targets instanceof Response) return targets
  const token = c.get('accessToken')
  if (path === SPEECH_PATH && token.plan && hasAnyLimit(token.plan.limits)) {
    const refusal = await windowLimitRefusal(c, token.id, token.plan.limits, 'openai')
    if (refusal !== null) return refusal
  }
  const model = modelName(body.model)
  let last = fail(502, 'The OpenAI upstream could not be reached.')
  for (const [index, target] of targets.entries()) {
    const upstream = await fetchProvider(
      `https://api.openai.com${path}`,
      { ...body, model },
      {
        headers: { authorization: `Bearer ${target.key}`, accept: c.req.header('accept') },
        httpsProxy: process.env.PROXY_URL,
        timeoutMs: 120_000,
        signal: c.req.raw.signal
      }
    ).catch(() => null)
    if (upstream === null) return last
    if (upstream.ok && path === DECISIONS_PATH) await recordDecisionSpend(c, upstream, target.provider, model)
    last = relayResponse(upstream)
    const fallback = token.policy?.providerMode.endsWith('_first') && token.policy.providerFallback
    if (!fallback || (upstream.status !== 429 && upstream.status !== 503) || index === targets.length - 1) return last
    await last.body?.cancel()
  }
  return last
}

export const handleOpenAISpeech = (c: Context, body: SpecializedBody): Promise<Response> =>
  relayOpenAI(c, SPEECH_PATH, body)

export async function handleDecisions(c: Context): Promise<Response> {
  const bytes = await readBoundedBody(c, MAX_DECISIONS_BYTES).catch(() => null)
  if (bytes === null) return fail(413, 'Decisions request exceeds the 32 MiB limit.')
  const body = readSpecializedBody(bytes)
  if (body === null || modelName(body.model) !== 'gpt-6-luna') return fail(400, 'Decisions requires gpt-6-luna.')
  return relayOpenAI(c, DECISIONS_PATH, body)
}

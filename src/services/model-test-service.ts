/**
 * Real-inference connectivity test for a single Model.
 *
 * Unlike providerTestService (which only hits the vendor's /v1/models
 * list to check the key), this sends a minimal real completion request
 * (max 1 output token, "ping") to the specific model and records the
 * outcome on the Model row (testStatus / testCheckedAt / testPassedAt /
 * testError).
 *
 * Request shaping is driven by the vendor's auth style:
 *   - x-api-key       -> Anthropic /v1/messages
 *   - google-key-param-> Gemini :generateContent
 *   - bearer / other  -> OpenAI-compatible /chat/completions
 *
 * Subscription-auth providers can't do a keyless real call here, so
 * they fall back to the credential reachability check.
 *
 * Vendor-specific probe shaping and error parsing live in
 * ./model-test/*; this file owns persistence + orchestration.
 */

import type { z } from '@hono/zod-openapi'
import { getPrismaClient } from '../db/client'
import { type ApiStyle, AuthMode, ModelTestStatus, type PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import type { ModelTestAllResponseSchema, ModelTestResultSchema } from '../schemas/api/models'
import { hasUnexpiredAccount } from '../shared/subscription-credential'
import { probeInference } from './model-test/probes'
import { probeSubscription } from './model-test/subscription-probe'
import { getSubscriptionsInfo } from './subscription-info-service'

export type ModelTestResult = z.infer<typeof ModelTestResultSchema>
export type TestAllOutcome = z.infer<typeof ModelTestAllResponseSchema>

const persist = async (
  prisma: PrismaClient,
  modelId: string,
  ok: boolean,
  error: string | undefined
): Promise<void> => {
  const now = dayjs().toDate()
  // Prefer ternary over `??` so the no-nullish-coalescing lint stays
  // happy; the fallback is purely defensive (probe errors always carry
  // a message in practice).
  const failureMessage = error ? error : 'unknown error'
  await prisma.model.update({
    where: { id: modelId },
    data: {
      testStatus: ok ? ModelTestStatus.ok : ModelTestStatus.fail,
      testCheckedAt: now,
      testError: ok ? null : failureMessage,
      ...(ok ? { testPassedAt: now } : {})
    }
  })
}

// Per-model apiStyle override wins; otherwise fall back to the
// provider's style. Plain ternary so the no-nullish-coalescing lint
// stays happy.
const resolveStyle = (modelStyle: ApiStyle | null, providerStyle: ApiStyle): ApiStyle =>
  modelStyle !== null ? modelStyle : providerStyle

const failResult = (provider: string, model: string, error: string, start: dayjs.Dayjs): ModelTestResult => ({
  provider,
  model,
  status: 'fail',
  error,
  latencyMs: dayjs().diff(start)
})

const runSubscriptionTest = async (
  prisma: PrismaClient,
  providerName: string,
  modelName: string,
  apiBaseUrl: string,
  style: ApiStyle,
  modelId: string,
  start: dayjs.Dayjs
): Promise<ModelTestResult> => {
  const probe = await probeSubscription(style, providerName, apiBaseUrl, modelName)
  await persist(prisma, modelId, probe.ok, probe.error)
  return {
    provider: providerName,
    model: modelName,
    status: probe.ok ? 'ok' : 'fail',
    error: probe.ok ? undefined : probe.error,
    latencyMs: dayjs().diff(start)
  }
}

export async function testModel(
  providerName: string,
  modelName: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<ModelTestResult> {
  const start = dayjs()
  const provider = await prisma.provider.findUnique({
    where: { name: providerName },
    include: { models: { where: { name: modelName } } }
  })
  if (!provider) {
    return { provider: providerName, model: modelName, status: 'fail', error: 'provider not found', latencyMs: 0 }
  }
  const modelRow = provider.models[0]
  if (!modelRow) {
    return failResult(providerName, modelName, 'model not found on provider', start)
  }

  // Authoritative enabled check from the DB — never trust the caller.
  // A disabled model is not tested or billed; its stored status is
  // left untouched.
  if (!modelRow.enabled) {
    return failResult(providerName, modelName, 'model is disabled', start)
  }

  const effectiveStyle = resolveStyle(modelRow.apiStyle, provider.apiStyle)

  // Subscription providers (claude-code / codex): make a *real* authed
  // call with the OAuth token from the credential file — not just a
  // file-presence check.
  if (provider.authMode === AuthMode.subscription) {
    return runSubscriptionTest(prisma, providerName, modelName, provider.apiBaseUrl, effectiveStyle, modelRow.id, start)
  }

  if (!provider.apiKey || provider.apiKey.trim() === '') {
    await persist(prisma, modelRow.id, false, 'no api key on file')
    return failResult(providerName, modelName, 'no api key on file', start)
  }

  // Both apiStyle inputs are explicit DB values — no endpoint guessing
  // / 404 probing.
  const probe = await probeInference(effectiveStyle, provider.apiBaseUrl, provider.apiKey, modelName)
  await persist(prisma, modelRow.id, probe.ok, probe.error)
  return {
    provider: providerName,
    model: modelName,
    status: probe.ok ? 'ok' : 'fail',
    error: probe.ok ? undefined : probe.error,
    latencyMs: dayjs().diff(start)
  }
}

// scope 'all' tests every enabled Model; 'failing' only enabled models
// whose current testStatus !== ok (never-tested + previously-failed).
// Models on providers with no usable credentials (api_key blank, or
// subscription without valid creds) are skipped entirely — there's no
// point spending a request to get "no api key on file". enabled is the
// authoritative DB column. Sequential to avoid rate-limit/billed
// bursts.
export async function testAllModels(
  scope: 'all' | 'failing',
  prisma: PrismaClient = getPrismaClient()
): Promise<TestAllOutcome> {
  const models = await prisma.model.findMany({
    where: {
      enabled: true,
      ...(scope === 'failing' ? { testStatus: { not: ModelTestStatus.ok } } : {})
    },
    include: { provider: { select: { name: true, apiKey: true, authMode: true } } },
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }]
  })

  // Which subscription providers actually have valid, unexpired creds —
  // asked of every account, since any of them may serve the request.
  const now = dayjs().valueOf()
  const subs = await getSubscriptionsInfo()
  const validSubscription = new Set(
    subs.filter((s) => s.enabled && hasUnexpiredAccount(s.accounts, now)).map((s) => s.providerName)
  )
  const hasCredentials = (p: { name: string; apiKey: string | null; authMode: AuthMode }): boolean =>
    p.authMode === AuthMode.subscription
      ? validSubscription.has(p.name)
      : p.apiKey !== null && p.apiKey.trim().length > 0

  const results: ModelTestResult[] = []
  for (const m of models) {
    if (!hasCredentials(m.provider)) continue
    results.push(await testModel(m.provider.name, m.name, prisma))
  }
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    fail: results.filter((r) => r.status === 'fail').length,
    results
  }
}

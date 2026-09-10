/**
 * Parity matrix — the "usage record (RequestLog)" row.
 *
 * A RequestLog row is assembled from two independent sources:
 *
 *   (1) **Surface attribution** — the `inboundType` / `surface` columns,
 *       stamped by `resolveInvocationForModel` from the descriptor.
 *       Per-surface, and breakable per-surface.
 *   (2) **Token counts** — the usage block on the upstream response.
 *       `captureUsage` reads them from a clone of the **raw upstream
 *       response, before conversion** (provider-send.ts clones ahead of
 *       `processResponseTransformers`), so the vocabulary it can read is
 *       decided by the **provider's** wire format.
 *
 * (2) belongs on a surface table because each surface has a default
 * provider it reaches when passing through. On gemini surface → Google
 * provider the upstream returns `usageMetadata`, which is absent from
 * `UsageBlockSchema`; usage comes back null and **no row is written at
 * all**.
 */

import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { resolveInvocationForModel } from '../../src/api/v1/invocation'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import type { PipelineDeps } from '../../src/llms/pipeline/types'
import { captureUsage } from '../../src/llms/pipeline/usage-extraction'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry, type ResolvedProvider } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import { OpenAIResponsesTransformer, OpenAITransformer } from '../../src/llms/transformers/openai'
import type { TransformerContext, UsageRecord } from '../../src/schemas/domain'

const log = pino({ level: 'silent' })
const provider = { name: 'p' } as ResolvedProvider

// Run captureUsage once and return the row it wrote, or null if it
// wrote none.
const rowFor = async (upstream: Response, context: TransformerContext): Promise<UsageRecord | null> => {
  const captured: { value: UsageRecord | null } = { value: null }
  const deps: PipelineDeps = {
    log,
    recordUsage: async (entry) => {
      captured.value = entry
    }
  }
  await captureUsage(upstream, context, provider, { model: 'm' }, 200, 12, deps)
  return captured.value
}

const json = (payload: Record<string, unknown>): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })

const sse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const ctxWithSession = (extra: Record<string, unknown> = {}): TransformerContext =>
  ({
    req: { headers: { 'x-claude-code-session-id': 'sess-1' }, model: 'm', ...extra }
  }) as unknown as TransformerContext

// ─── (1) surface attribution ────────────────────────────────────────

const PROVIDERS = [
  {
    name: 'p',
    auth_mode: 'api_key' as const,
    api_style: 'openai_chat' as const,
    api_key: 'sk',
    api_base_url: 'https://example.test/v1/chat/completions',
    models: ['m']
  }
]

async function buildContext(): Promise<LlmsContext> {
  const transformers = new TransformerRegistry(log)
  transformers.registerMany([
    new AnthropicTransformer(),
    new OpenAITransformer(),
    new OpenAIResponsesTransformer(),
    new GeminiTransformer()
  ])
  const providers = new ProviderRegistry(transformers, log)
  providers.registerFromConfig(PROVIDERS)
  const tokenizers = new TokenizerRegistry(log)
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  return { config, transformers, providers, tokenizers, log }
}

const planFor = (path: string): RoutePlan => ({
  routedBody: { model: 'p,m' },
  headers: {},
  transformersByName: new Map(),
  defaultTransformer: new OpenAITransformer(),
  scenarioType: 'default',
  primaryModel: 'p,m',
  isSubagent: false,
  fallbacks: [],
  path,
  search: '',
  accountSessionKey: 'anonymous'
})

describe('surface attribution — every surface stamps its own inboundType and surface', () => {
  const CASES: ReadonlyArray<[string, string, string]> = [
    ['/v1/messages', 'anthropic', 'anthropic-messages'],
    ['/v1/chat/completions', 'openai', 'openai-chat'],
    ['/v1/responses', 'openai', 'openai-responses'],
    ['/v1beta/models/gemini-3-pro:generateContent', 'gemini', 'gemini-generate']
  ]

  for (const [path, inboundType, surface] of CASES) {
    test(`${path} → inboundType=${inboundType} / surface=${surface}`, async () => {
      const ctx = await buildContext()
      const inv = resolveInvocationForModel(planFor(path), 'p,m', ctx)
      expect(inv?.request.inboundType).toBe(inboundType)
      expect(inv?.request.surface).toBe(surface)
    })
  }

  test('a path that is not a surface (/v1/models and friends) stays null rather than landing in the wrong bucket', async () => {
    const ctx = await buildContext()
    const inv = resolveInvocationForModel(planFor('/v1/models'), 'p,m', ctx)
    expect(inv?.request.inboundType).toBeUndefined()
    expect(inv?.request.surface).toBeUndefined()
  })

  test('the stamped attribution reaches the RequestLog row unchanged', async () => {
    const row = await rowFor(
      json({ usage: { input_tokens: 10, output_tokens: 4 } }),
      ctxWithSession({ inboundType: 'gemini', surface: 'gemini-generate', requestedModel: 'gemini-3-pro' })
    )
    expect(row).toMatchObject({
      sessionId: 'sess-1',
      inboundType: 'gemini',
      surface: 'gemini-generate',
      requestedModel: 'gemini-3-pro'
    })
  })
})

// ─── (2) token counts ───────────────────────────────────────────────

describe('token counts, by upstream wire format', () => {
  test('anthropic (JSON) — supported', async () => {
    const row = await rowFor(json({ usage: { input_tokens: 10, output_tokens: 4 } }), ctxWithSession())
    expect(row).toMatchObject({ inputTokens: 10, outputTokens: 4, totalInputTokens: 10 })
  })

  test('anthropic (SSE) — supported: message_start and message_delta merge', async () => {
    const row = await rowFor(
      sse(
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n` +
          `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 4 } })}\n\n`
      ),
      ctxWithSession()
    )
    expect(row).toMatchObject({ inputTokens: 10, outputTokens: 4 })
  })

  test('openai-chat (JSON) — supported: prompt_tokens / completion_tokens', async () => {
    const row = await rowFor(json({ usage: { prompt_tokens: 20, completion_tokens: 7 } }), ctxWithSession())
    expect(row).toMatchObject({ inputTokens: 20, outputTokens: 7 })
  })

  test('openai-responses (SSE) — supported: reads the usage on response.completed', async () => {
    const row = await rowFor(
      sse(
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 30, output_tokens: 9 } } })}\n\n`
      ),
      ctxWithSession()
    )
    expect(row).toMatchObject({ inputTokens: 30, outputTokens: 9 })
  })

  test('gemini (JSON) — supported: reads usageMetadata', async () => {
    // Gemini puts its counters in `usageMetadata` at the response root
    // rather than under `usage`. Unread, `extractUsage` returns null,
    // `captureUsage` returns immediately, and not one RequestLog row is
    // written — which is why Gemini traffic appeared in neither Activity
    // nor the cost figures.
    const row = await rowFor(
      json({
        candidates: [],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9, totalTokenCount: 39 }
      }),
      ctxWithSession()
    )
    expect(row).toMatchObject({ inputTokens: 30, outputTokens: 9, totalInputTokens: 30 })
  })

  test('gemini (SSE) — supported: picks up usageMetadata from the chunks', async () => {
    // The values are cumulative, so the last one seen wins.
    const row = await rowFor(
      sse(
        `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 30 } })}\n\n` +
          `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 } })}\n\n`
      ),
      ctxWithSession()
    )
    expect(row).toMatchObject({ inputTokens: 30, outputTokens: 9 })
  })
})

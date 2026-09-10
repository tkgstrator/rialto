/**
 * Pipeline runtime types for the LLM proxy.
 *
 * `RuntimeProvider` is the snake_case provider shape the pipeline
 * (and every transformer hook) consumes — derived from AppConfig.Providers
 * with the subscription overlay applied. `TransformerContext` and the
 * hook-result helpers describe the per-request state that flows between
 * pipeline stages.
 *
 * Schemas are Zod where the value crosses a trust boundary (provider
 * config from DB / disk). The pure in-process helpers (TransformerContext
 * et al.) are plain TS types — Zod-parsing every internal hand-off would
 * be pure ceremony.
 */

import { z } from '@hono/zod-openapi'

// ─── Runtime provider ──────────────────────────────────────────────────

/**
 * `transformer.use` is intentionally loose: it holds the Transformer
 * instances the registry derived for this provider. Nothing configures
 * it — see `shared/transformer-chain.ts` — and consumers (hooks) only
 * read sibling fields like `subscriptionCredentialPath` /
 * `subscriptionAuth`, never the use chain itself.
 */
export const ProviderTransformerConfigSchema = z
  .object({
    use: z.array(z.unknown()).default([])
  })
  .catchall(z.unknown())
export type ProviderTransformerConfig = z.input<typeof ProviderTransformerConfigSchema>

export const ProviderModelTransformerConfigSchema = z.object({
  use: z.array(z.unknown()).default([])
})
export type ProviderModelTransformerConfig = z.input<typeof ProviderModelTransformerConfigSchema>

export const RuntimeProviderSchema = z.object({
  name: z.string().nonempty(),
  api_base_url: z.string().nonempty(),
  api_key: z.string().nonempty(),
  models: z.array(z.string().nonempty()).default([]),
  transformer: ProviderTransformerConfigSchema.optional(),
  // Per-model manual reasoning-effort override consumed by OpenAI /
  // OpenAI-Responses / Codex transformers when building the outgoing
  // request. Absent = pass-through (vendor default).
  modelReasoningEfforts: z
    .record(z.string().nonempty(), z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .optional()
})
export type RuntimeProvider = z.input<typeof RuntimeProviderSchema>

// ─── Provider config (registry input form) ─────────────────────────────

export const ApiStyleSchema = z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini'])

/**
 * What the registry needs to build a provider.
 *
 * There is no `use` chain on this side. The chain is derived from
 * `api_style` + `auth_mode` (see `shared/transformer-chain.ts`), so the
 * registry is handed the two columns rather than a pre-resolved list of
 * transformer names — which is what makes the chain impossible to
 * configure into an invalid state. `transformer` survives only as the
 * carrier for the subscription credential keys the OAuth base reads
 * (`subscriptionCredentialPath`, `subscriptionAuth`).
 */
export const ProviderConfigShapeSchema = RuntimeProviderSchema.extend({
  auth_mode: z.enum(['api_key', 'subscription']),
  api_style: ApiStyleSchema.optional(),
  // Per-model wire-format override (Model.apiStyle). Only models whose
  // column is non-null appear; a model that agrees with its provider
  // needs no per-model chain.
  modelApiStyles: z.record(z.string().nonempty(), ApiStyleSchema).optional(),
  transformer: z.object({}).catchall(z.unknown()).optional()
})
export type ProviderConfigShape = z.input<typeof ProviderConfigShapeSchema>

// ─── Pipeline transient state ──────────────────────────────────────────
// In-process only — never `safeParse`d. Schemas exist so the inferred
// types stay the single source of truth, not so callers validate at the
// boundary.

export const PipelineRequestSchema = z.object({
  // HTTP header values are legitimately allowed to be empty per RFC; .min(0) keeps
  // the schema explicit about that while satisfying the no-bare-z-string plugin.
  headers: z.record(z.string().nonempty(), z.string().min(0)),
  body: z.record(z.string().nonempty(), z.unknown()),
  url: z.string().nonempty(),
  provider: z.string().nonempty().optional(),
  model: z.string().nonempty().optional(),
  scenarioType: z.string().nonempty().optional(),
  // The client's original body.model, captured before scenario routing
  // rewrote it. Carried so the usage-capture step can persist "what was
  // asked for" alongside "what was actually sent".
  requestedModel: z.string().nonempty().optional(),
  // True when the request carried a <RIALTO-SUBAGENT-MODEL> tag and was
  // routed through the subagent lane. Always known — the route builder
  // stamps it before the pipeline runs — so it stays a plain boolean
  // (no optional / nullable) at this layer.
  isSubagent: z.boolean().default(false),
  // Which wire format the request came in on. Set by the /v1 route
  // builder from the inbound path — 'anthropic' for /v1/messages
  // (Claude Code), 'openai' for /v1/chat/completions and /v1/responses,
  // 'gemini' for /v1beta/models/*. Persisted on RequestLog / Session so
  // the History view can filter by inbound type without re-parsing the
  // path from the payload.
  inboundType: z.enum(['anthropic', 'openai', 'gemini']).optional(),
  // Which inbound surface the request arrived on, as an
  // `InboundSurface.id` slug. Finer than `inboundType`, which cannot
  // tell /v1/chat/completions from /v1/responses.
  surface: z.enum(['anthropic-messages', 'openai-chat', 'openai-responses', 'gemini-generate']).optional(),
  // Which AccessToken authenticated the request, so Activity can answer
  // "which client burned this". /v1 admits issued tokens only, so this
  // is absent only on a request that never went through that gate.
  accessTokenId: z.string().nonempty().optional(),
  sessionId: z.string().nonempty().optional(),
  // The key the subscription sub-account picker sticks on, resolved once
  // per request by the /v1 route layer. Distinct from the archive's
  // session id (`resolveSessionId`): a client that sends no session
  // header still needs ONE stable key here, or every request re-enters
  // the picker as a stranger and the OAuth transformer falls back to the
  // provider's stored active account. Absent on probe contexts, which
  // deliberately test that active account.
  accountSessionKey: z.string().nonempty().optional(),
  tokenCount: z.number().optional()
})
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>

export const TransformerContextSchema = z.object({ req: PipelineRequestSchema.optional() }).catchall(z.unknown())
export type TransformerContext = z.infer<typeof TransformerContextSchema>

export const TransformerConfigSchema = z.object({
  url: z.union([z.instanceof(URL), z.string().nonempty()]).optional(),
  // Header values may be empty per RFC; .min(0) keeps that explicit while
  // satisfying the no-bare-z-string plugin.
  headers: z.record(z.string().nonempty(), z.union([z.string().min(0), z.undefined()])).optional()
})
export type TransformerConfig = z.infer<typeof TransformerConfigSchema>

export const TransformerHookResultSchema = z.object({
  body: z.unknown().optional(),
  config: TransformerConfigSchema.optional()
})
export type TransformerHookResult = z.infer<typeof TransformerHookResultSchema>

/**
 * Runtime guard for the TransformerHookResult shape. Hooks return either
 * a `{ body, config? }` object or a plain replacement body — the
 * pipeline branches on this guard to merge correctly.
 */
export function isTransformerHookResult(value: unknown): value is TransformerHookResult {
  if (value === null || typeof value !== 'object') return false
  if (!('body' in value)) return false
  const body: unknown = Reflect.get(value, 'body')
  return body !== undefined
}

/** Shape returned by Transformer.auth() in bypass mode. Same as
 *  TransformerHookResult; the alias keeps call sites readable as
 *  "this is auth" vs "this is a transform hook". */
export const TransformerAuthResultSchema = TransformerHookResultSchema
export type TransformerAuthResult = z.infer<typeof TransformerAuthResultSchema>

// ─── Pipeline body access shape ────────────────────────────────────────
// Loose accessor view: the pipeline only inspects four fields on the
// (unknown) request body — model, stream, messages, tools. Manual
// extraction with type guards keeps the inferred shape strict while
// staying tolerant of the wildly different transformer body shapes.

export type PipelineBodyView = {
  model?: string
  stream?: boolean
  messages?: readonly unknown[]
  tools?: readonly unknown[]
}

/**
 * Best-effort accessor view for an unknown request body. Returns a
 * fully-typed object (with `undefined` fields when shape mismatches)
 * so call sites don't need `as` casts to read `model` / `stream` etc.
 */
export function viewPipelineBody(body: unknown): PipelineBodyView {
  if (body === null || typeof body !== 'object') return {}
  const view: PipelineBodyView = {}
  const model: unknown = Reflect.get(body, 'model')
  if (typeof model === 'string' && model.length > 0) view.model = model
  const stream: unknown = Reflect.get(body, 'stream')
  if (typeof stream === 'boolean') view.stream = stream
  const messages: unknown = Reflect.get(body, 'messages')
  if (Array.isArray(messages)) view.messages = messages
  const tools: unknown = Reflect.get(body, 'tools')
  if (Array.isArray(tools)) view.tools = tools
  return view
}

// ─── Provider-transformer per-model block accessor ─────────────────────

export type ProviderModelBlock = {
  use?: readonly unknown[]
}

/**
 * Runtime guard for the per-model `transformer[modelName] = { use: [...] }`
 * block. Returns false for the top-level `use` array or unknown sibling
 * keys (subscriptionCredentialPath, subscriptionAuth, ...).
 */
export function isProviderModelBlock(value: unknown): value is ProviderModelBlock {
  if (value === null || typeof value !== 'object') return false
  if (!('use' in value)) return true
  const use: unknown = Reflect.get(value, 'use')
  return use === undefined || Array.isArray(use)
}

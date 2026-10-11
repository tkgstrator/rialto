/**
 * Request pipeline.
 *
 * Replaces vendor/api/routes.ts `handleTransformerEndpoint`. The Hono
 * /v1 adapter (src/api/v1/route.ts) resolves the endpoint transformer
 * by path and the routed-to provider/model, then hands both to this
 * function. The pipeline:
 *
 *   1. runs the endpoint transformer's `transformRequestOut` (wire →
 *      unified shape), unless bypass mode applies,
 *   2. runs the provider's `transformer.use` chain (each
 *      `transformRequestIn`),
 *   3. runs any model-specific `transformer[model].use` chain,
 *   4. calls the endpoint transformer's `auth` hook in bypass mode,
 *   5. POSTs the unified request to the provider,
 *   6. runs the response chain in reverse,
 *   7. runs the endpoint transformer's `transformResponseIn`,
 *   8. returns the upstream `Response` to the adapter for SSE/JSON
 *      relay.
 *
 * Errors are surfaced as Hono HTTPException; the v1 adapter forwards
 * the upstream body verbatim so Claude Code can react to genuine
 * rate-limit / billing errors.
 *
 * The stages themselves live under `src/llms/pipeline/`:
 *   - `request-chain.ts`     bypass detection + request transformer chain
 *   - `response-chain.ts`    response transformer chain (reverse order)
 *   - `provider-send.ts`     header/auth assembly, upstream fetch, logging
 *   - `usage-extraction.ts`  best-effort usage-row capture
 *   - `message-capture.ts`   best-effort chat-view message capture
 *   - `session-id.ts`        shared session-id resolution
 */

import type { PipelineBodyView, TransformerHookResult } from '@/schemas/domain/pipeline'
import { captureAssistantMessage, extractLastUserContent } from './pipeline/message-capture'
import { sendToProvider } from './pipeline/provider-send'
import { processRequestTransformers, shouldBypass } from './pipeline/request-chain'
import { processResponseTransformers } from './pipeline/response-chain'
import { resolveSessionId } from './pipeline/session-id'
import type { PipelineDeps, PipelineInput } from './pipeline/types'

export type { MessageRecord, UsageRecord } from '@/schemas/domain/usage-record'
export type { PipelineDeps, PipelineInput } from './pipeline/types'

/**
 * Run the pipeline and return the upstream Response. The caller is
 * responsible for formatting it back to the inbound client (JSON vs
 * SSE, status code, headers).
 */
export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<Response> {
  const { provider, transformer } = input

  // Capture at the client wire boundary, not between vendor transforms: Codex
  // replaces messages with input and returns Responses events, not tool_use.
  const userContent = structuredClone(extractLastUserContent(input.body))
  const sessionId = resolveSessionId(input.context)
  const captureLog = deps.log.child({ sessionId })
  const bypass = shouldBypass(provider.transformer, transformer, input.body)
  const { requestBody, config } = await processRequestTransformers(input, bypass)
  if (deps.recordMessages && userContent !== null) {
    void deps.recordMessages([{ sessionId, role: 'user', content: userContent }]).catch(() => {
      captureLog.warn({ event: 'message_capture_failed', phase: 'user' }, 'User message archive failed')
    })
  }
  const upstream = await sendToProvider(requestBody, config, provider, transformer, bypass, input.context, deps)
  const response = await processResponseTransformers(
    requestBody,
    upstream,
    provider,
    transformer,
    bypass,
    input.context
  )
  // Keep observation enabled without persistence; never consume the client's stream.
  if (response.ok && typeof response.clone === 'function') {
    void captureAssistantMessage(response.clone(), sessionId, { ...deps, log: captureLog }).catch(() => {
      captureLog.warn({ event: 'message_capture_failed', phase: 'assistant' }, 'Assistant message archive failed')
    })
  }
  return response
}

// Re-export helper types used by tests / callers that previously imported
// them from this file.
export type { PipelineBodyView, TransformerHookResult }

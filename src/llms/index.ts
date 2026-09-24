/**
 * Public surface of the app-side LLM proxy core.
 *
 * Replaces every `@/llms/*` import that previously resolved into the
 * vendored @musistudio/llms package. The Hono /v1 adapter is the only
 * caller; everything below this barrel is implementation detail.
 */

export { getLlmsContext, type LlmsContext, resetLlmsContext } from './context'
export {
  type MessageRecord,
  type PipelineDeps,
  type PipelineInput,
  runPipeline,
  type UsageRecord
} from './pipeline'
export type { ResolvedProvider } from './registry/provider'
export {
  PASSTHROUGH_ROUTE,
  type RouterContext,
  type RouterRequest,
  routeRequest,
  subscriptionKindOf
} from './scenario-router'
// Re-export the transformer base + concrete types for callers that need
// to compare names / endpoints.
export { Transformer } from './transformers/base'

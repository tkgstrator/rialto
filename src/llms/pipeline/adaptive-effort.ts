import type { TransformerContext } from '@/schemas/domain/pipeline'
import { adaptiveEffortForTarget } from '../../services/adaptive-reasoning-effort'
import { codexEffortsFor } from '../../services/codex-model-catalog'
import { claudeCodeEffortsFor, openAiEffortsFor, supportsReasoningEffort } from '../../shared/model-reasoning-effort'
import type { ResolvedProvider } from '../registry/provider'

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object(value) : null

function clientSetEffort(context: TransformerContext): boolean {
  if (context.req?.clientEffortIntent !== undefined) return context.req.clientEffortIntent === 'explicit'
  const inbound = context.req?.body
  if (inbound === undefined) return false
  const reasoning = recordOf(inbound.reasoning)
  const thinking = recordOf(inbound.thinking)
  const output = recordOf(inbound.output_config)
  return (
    'reasoning_effort' in inbound ||
    (reasoning !== null && 'effort' in reasoning) ||
    (thinking !== null && ('budget_tokens' in thinking || 'type' in thinking)) ||
    (output !== null && 'effort' in output)
  )
}

function isCodex(provider: ResolvedProvider): boolean {
  return provider.api_base_url.includes('chatgpt.com/backend-api/codex')
}

function outboundShape(provider: ResolvedProvider, model: string): 'chat' | 'responses' | 'anthropic' | null {
  const steps = provider.transformer?.use === undefined ? [] : provider.transformer.use
  const modelSteps = recordOf(provider.transformer?.[model])?.use
  const names = [...steps, ...(Array.isArray(modelSteps) ? modelSteps : [])].map((step) => step?.name)
  if (names.includes('claude-code-oauth')) return 'anthropic'
  if (names.includes('openai-responses')) return 'responses'
  return names.includes('openai') ? 'chat' : null
}

function insertEffort(
  body: Record<string, unknown>,
  shape: 'chat' | 'responses' | 'anthropic',
  effort: string
): boolean {
  if (shape === 'anthropic') {
    const output = recordOf(body.output_config)
    if (output !== null && 'effort' in output) return false
    body.output_config = { ...(output === null ? {} : output), effort }
    return true
  }
  if (shape === 'chat') {
    if (body.reasoning_effort !== undefined) return false
    body.reasoning_effort = effort
    return true
  }
  const reasoning = recordOf(body.reasoning)
  if (reasoning?.effort !== undefined) return false
  body.reasoning = {
    ...(reasoning === null ? {} : reasoning),
    effort,
    summary: reasoning?.summary === undefined ? 'detailed' : reasoning.summary
  }
  return true
}

export function applyBypassManualEffort(body: unknown, provider: ResolvedProvider, context: TransformerContext): void {
  const model = context.req?.model
  if (model === undefined) return
  const manual = provider.modelReasoningEfforts?.[model]
  if (manual === undefined || manual === 'auto') return
  const shape = outboundShape(provider, model)
  const shaped = recordOf(body)
  if (shape === null || shaped === null) return
  if (shape === 'anthropic') {
    if (claudeCodeEffortsFor(model)?.includes(manual)) {
      const output = recordOf(shaped.output_config)
      shaped.output_config = { ...(output === null ? {} : output), effort: manual }
    }
    return
  }
  if (shape === 'chat') {
    if (supportsReasoningEffort(model)) shaped.reasoning_effort = manual
    return
  }
  const reasoning = recordOf(shaped.reasoning)
  shaped.reasoning = { ...(reasoning === null ? {} : reasoning), effort: manual }
}

function supportedEfforts(
  provider: ResolvedProvider,
  model: string,
  shape: 'chat' | 'responses' | 'anthropic',
  account: string | undefined
) {
  if (shape === 'anthropic') return claudeCodeEffortsFor(model)
  if (!isCodex(provider)) return openAiEffortsFor(model)
  return account === undefined ? null : codexEffortsFor(account, model)
}

export function applyAdaptiveEffort(
  body: unknown,
  provider: ResolvedProvider,
  context: TransformerContext
): { body: unknown; projectedPct: number; effort: string } | null {
  const model = context.req?.model
  if (model === undefined) return null
  if (provider.modelReasoningEfforts?.[model] !== 'auto' || clientSetEffort(context)) return null
  const shaped = recordOf(body)
  if (shaped === null || shaped.model !== model) return null
  const shape = outboundShape(provider, model)
  if (shape === null || (shape !== 'anthropic' && !isCodex(provider) && !supportsReasoningEffort(model))) return null
  const supported = supportedEfforts(provider, model, shape, context.req?.subAccountId)
  const decision = adaptiveEffortForTarget(`${provider.name},${model}`, supported)
  if (decision === null || !insertEffort(shaped, shape, decision.effort)) return null
  return { body: shaped, ...decision }
}

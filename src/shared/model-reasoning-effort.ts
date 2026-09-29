import { REASONING_MODEL_RE } from './reasoning-model'

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export type ReasoningEffortSetting = ReasoningEffort | 'auto'

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  REASONING_EFFORTS.some((effort) => effort === value)

const GPT5 = ['minimal', 'low', 'medium', 'high'] as const
const GPT51 = ['none', 'low', 'medium', 'high'] as const
const GPT52_PLUS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const GPT56_PLUS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const ASTRA = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Only published, individually verified model IDs belong here. A family
// regex is useful for wire conversion, but cannot prove effort support.
const OPENAI_EFFORTS: Record<string, readonly ReasoningEffort[]> = {
  'gpt-5': GPT5,
  'gpt-5.1': GPT51,
  'gpt-5.2': GPT52_PLUS,
  'gpt-5.4': GPT52_PLUS,
  'gpt-5.4-mini': GPT52_PLUS,
  'gpt-5.5': GPT52_PLUS,
  'gpt-5.6': GPT56_PLUS,
  'gpt-5.6-terra': GPT56_PLUS,
  'gpt-5.6-sol': GPT56_PLUS,
  'gpt-5.6-luna': GPT56_PLUS,
  'gpt-6-astra': ASTRA,
  'gpt-6-sol': GPT56_PLUS,
  'gpt-6-luna': GPT56_PLUS
}

// Claude Code and Codex models carry no table here: the levels each accepts
// are read once from the subscription's own model list and recorded
// (ModelCapability, surfaced as Provider.modelSupportedEfforts). This table
// serves api_key OpenAI models, whose catalog does not publish them.
export function openAiEffortsFor(model: string): readonly ReasoningEffort[] | null {
  const supported = OPENAI_EFFORTS[model]
  return supported === undefined ? null : supported
}

export function supportsReasoningEffort(model: string): boolean {
  return REASONING_MODEL_RE.test(model)
}

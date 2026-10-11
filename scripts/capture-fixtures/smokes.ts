import { z } from 'zod'
import type { RequestSpec } from './types'

const SmokeModelSchema = z.object({
  model: z.string().nonempty(),
  variants: z.array(z.enum(['stream-hello', 'stream-pong', 'nonstream-42']))
})
type SmokeModel = z.infer<typeof SmokeModelSchema>

export function buildSmokeSpecs(messagesUrl: string): RequestSpec[] {
  const specs: RequestSpec[] = []
  // openai test matrix (see __tests__/providers/openai.test.ts)
  type OpenaiTest = SmokeModel
  const openaiTests: OpenaiTest[] = [
    { model: 'gpt-4.1-mini', variants: ['stream-hello', 'stream-pong', 'nonstream-42'] },
    { model: 'gpt-4.1', variants: ['stream-hello'] },
    { model: 'gpt-5.5', variants: ['stream-hello', 'stream-pong'] },
    { model: 'gpt-5.4', variants: ['stream-hello', 'stream-pong', 'nonstream-42'] },
    { model: 'gpt-5.3-codex', variants: ['stream-hello', 'stream-pong'] }
  ]
  for (const { model, variants } of openaiTests) {
    for (const v of variants) {
      const body = openaiBody(model, v)
      specs.push({
        label: `openai/${model}: ${v}`,
        slug: `openai-${model}-${v}`,
        method: 'POST',
        url: messagesUrl,
        body
      })
    }
  }

  function openaiBody(model: string, variant: string) {
    switch (variant) {
      case 'stream-hello':
        return {
          model: `openai,${model}`,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Say exactly: hello' }],
          stream: true
        }
      case 'stream-pong':
        return {
          model: `openai,${model}`,
          max_tokens: 50,
          messages: [{ role: 'user', content: "Reply with the word 'pong' only." }],
          stream: true
        }
      case 'nonstream-42':
        return {
          model: `openai,${model}`,
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Reply with only the number 42.' }],
          stream: false
        }
      default:
        throw new Error(`unknown variant ${variant}`)
    }
  }

  // gemini test matrix (see __tests__/providers/gemini.test.ts)
  type GeminiTest = SmokeModel
  const geminiTests: GeminiTest[] = [
    { model: 'gemini-2.5-flash', variants: ['stream-hello', 'stream-pong', 'nonstream-42'] },
    { model: 'gemini-2.5-pro', variants: ['stream-hello'] },
    { model: 'gemini-3.1-pro-preview', variants: ['stream-hello', 'stream-pong'] }
  ]
  for (const { model, variants } of geminiTests) {
    for (const v of variants) {
      specs.push({
        label: `google/${model}: ${v}`,
        slug: `google-${model}-${v}`,
        method: 'POST',
        url: messagesUrl,
        body: geminiBody(model, v)
      })
    }
  }

  function geminiBody(model: string, variant: string) {
    switch (variant) {
      case 'stream-hello':
        return {
          model: `google,${model}`,
          max_tokens: 100,
          messages: [{ role: 'user', content: 'Say exactly: hello' }],
          stream: true
        }
      case 'stream-pong':
        return {
          model: `google,${model}`,
          max_tokens: 50,
          messages: [{ role: 'user', content: "Reply with the word 'pong' only." }],
          stream: true
        }
      case 'nonstream-42':
        return {
          model: `google,${model}`,
          max_tokens: 50,
          messages: [{ role: 'user', content: 'Reply with only the number 42.' }],
          stream: false
        }
      default:
        throw new Error(`unknown variant ${variant}`)
    }
  }

  return specs
}

export function buildSubscriptionSpecs(
  messagesUrl: string,
  matrix: readonly { name: string; models: string[] }[]
): RequestSpec[] {
  const specs: RequestSpec[] = []
  for (const { name, models } of matrix) {
    for (const model of models) {
      specs.push({
        label: `${name}/${model}: subscription smoke`,
        slug: `${name}-${model}-smoke`,
        method: 'POST',
        url: messagesUrl,
        body: {
          model: `${name},${model}`,
          max_tokens: 64,
          messages: [{ role: 'user', content: "Reply with the word 'pong' only." }],
          stream: true
        }
      })
    }
  }

  return specs
}

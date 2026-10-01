import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeRequest } from '../../src/llms/router'
import type { RouterRequest } from '../../src/llms/router/types'
import { __resetJeffQueueForTest } from '../../src/services/jeff-client'
import {
  latestPlainTextInstruction,
  modelEffortChoices,
  shadowEvaluateSubagent
} from '../../src/services/subagent-shadow-evaluation'
import { PASSTHROUGH_PROFILE_KEY } from '../../src/services/tier-route-service'

const originalFetch = globalThis.fetch
const originalEnabled = process.env.JEFF_SHADOW_ENABLED
const originalUrl = process.env.JEFF_URL
const logs: string[] = []
const log = pino({ level: 'info' }, { write: (line: string) => logs.push(line) })
const tag = '<RIALTO-SUBAGENT-MODEL>sonnet</RIALTO-SUBAGENT-MODEL>'

function request(instruction: string, tagged = true): RouterRequest {
  return {
    body: {
      model: 'original-model',
      system: [
        { type: 'text', text: 'preamble' },
        { type: 'text', text: tagged ? tag : 'ordinary system' }
      ],
      messages: [{ role: 'user', content: instruction }]
    },
    log,
    inboundPath: '/v1/messages',
    profileKeyOverride: PASSTHROUGH_PROFILE_KEY
  }
}

async function route(req: RouterRequest): Promise<void> {
  await routeRequest(req, { config: new ConfigStore({}), tokenizers: new TokenizerRegistry() })
}

async function flushShadow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  __resetJeffQueueForTest()
  process.env.JEFF_SHADOW_ENABLED = 'true'
  process.env.JEFF_URL = 'http://127.0.0.1:8000'
  logs.length = 0
})

afterEach(() => {
  __resetJeffQueueForTest()
  globalThis.fetch = originalFetch
  if (originalEnabled === undefined) delete process.env.JEFF_SHADOW_ENABLED
  else process.env.JEFF_SHADOW_ENABLED = originalEnabled
  if (originalUrl === undefined) delete process.env.JEFF_URL
  else process.env.JEFF_URL = originalUrl
})

describe('subagent shadow evaluation', () => {
  test('runs only for tagged requests and only when opted in', async () => {
    const calls: string[] = []
    globalThis.fetch = async (_url, options) => {
      calls.push(String(options?.body))
      return Response.json({
        model: 'jeff-local',
        answers: { complexity: { type: 'score', score: 2, confidence: 0.8, probabilities: {}, legend: {} } },
        usage: { input_tokens: 7, output_tokens: 4 }
      })
    }
    await route(request('Please fix the task', false))
    await flushShadow()
    expect(calls).toHaveLength(0)

    process.env.JEFF_SHADOW_ENABLED = 'false'
    await route(request('Please fix the task'))
    await flushShadow()
    expect(calls).toHaveLength(0)

    process.env.JEFF_SHADOW_ENABLED = 'true'
    await route(request('Please fix the task'))
    await flushShadow()
    expect(calls).toHaveLength(1)
    const payload = JSON.parse(calls[0])
    expect(payload.state).toBe('Please fix the task')
    expect(payload.model).toBe('jeff-latest')
    expect(payload.questions.complexity.criteria).toHaveLength(2)
    expect(logs.join(' ')).not.toContain('Please fix the task')
  })

  test('keeps the shadow timeout at three seconds', async () => {
    const timeout = spyOn(AbortSignal, 'timeout')
    globalThis.fetch = async () => Response.json({})
    try {
      await route(request('Please review this implementation'))
      await flushShadow()
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([3_000])
    } finally {
      timeout.mockRestore()
    }
  })

  test('gives up quickly and logs unavailable when Jeff is busy with another evaluation', async () => {
    const setTimer = spyOn(globalThis, 'setTimeout')
    globalThis.fetch = () => new Promise(() => {})
    try {
      // The first observation takes the only turn and never finishes.
      shadowEvaluateSubagent({ messages: [{ role: 'user', content: 'Please fix the first task' }], log })
      await flushShadow()
      shadowEvaluateSubagent({ messages: [{ role: 'user', content: 'Please fix the second task' }], log })
      await flushShadow()
      // The second one waits for its turn with the short shadow limit, not the playground's 15 s.
      const waits = setTimer.mock.calls.map(([, milliseconds]) => milliseconds)
      expect(waits).toContain(3_000)
      expect(waits).not.toContain(15_000)
    } finally {
      setTimer.mockRestore()
    }
  })

  test('does not await Jeff or alter the upstream request/model', async () => {
    const calls: string[] = []
    globalThis.fetch = (_url, options) => {
      calls.push(String(options?.body))
      return new Promise(() => {})
    }
    const req = request('Please update the implementation')
    const originalMessages = structuredClone(req.body.messages)
    await route(req)
    await flushShadow()
    expect(calls).toHaveLength(1)
    expect(req.body.model).toBe('original-model')
    expect(req.body.messages).toEqual(originalMessages)
    expect(req.body.system).toEqual([
      { type: 'text', text: 'preamble' },
      { type: 'text', text: '' }
    ])
    expect(req.isSubagent).toBe(true)
    expect(req.route).toBe('passthrough')
  })

  test('offers only real model and supported-effort combinations', () => {
    const choices = modelEffortChoices([
      { target: 'claude-code,claude-sonnet-5-5', targetTier: 'sonnet', efforts: ['low', 'high'] },
      { target: 'codex,gpt-6-sol', targetTier: 'opus', efforts: [] }
    ])
    expect(choices?.options).toEqual([
      { key: '1', target: 'claude-code,claude-sonnet-5-5', effort: 'low' },
      { key: '2', target: 'claude-code,claude-sonnet-5-5', effort: 'high' },
      { key: '3', target: 'codex,gpt-6-sol', effort: null }
    ])
    expect(choices?.criteria['3']).toContain('vendor default')
    expect(modelEffortChoices([{ target: 'one,model', targetTier: 'sonnet', efforts: [] }])).toBeNull()
    expect(
      modelEffortChoices(
        Array.from({ length: 27 }, (_, i) => ({
          target: `provider,model-${i}`,
          targetTier: 'sonnet',
          efforts: []
        }))
      )
    ).toBeNull()
  })

  test('records hypothetical model and effort without sending prompt text to logs', async () => {
    const calls: string[] = []
    globalThis.fetch = async (_url, options) => {
      calls.push(String(options?.body))
      return Response.json({
        model: 'jeff-latest',
        answers: {
          complexity: {
            type: 'score',
            score: 0.8,
            confidence: 0.7,
            probabilities: { '0': 0.2, '1': 0.8 },
            legend: { '0': 'Simple', '1': 'Complex' }
          },
          modelEffort: { type: 'choice', choice: '2', confidence: 0.75, probabilities: { '1': 0.25, '2': 0.75 } }
        },
        usage: { input_tokens: 30, output_tokens: 0 }
      })
    }
    shadowEvaluateSubagent({
      messages: [{ role: 'user', content: 'Please review this implementation' }],
      log,
      candidates: [{ target: 'claude-code,claude-sonnet-5-5', targetTier: 'sonnet', efforts: ['low', 'high'] }]
    })
    await flushShadow()
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]).questions.modelEffort.criteria['2']).toContain('high')
    const line = logs.at(-1)
    if (line === undefined) throw new Error('shadow result was not logged')
    const row = JSON.parse(line)
    expect(row.routedPrimary).toBe('claude-code,claude-sonnet-5-5')
    expect(row.estimatedModel).toBe('claude-code,claude-sonnet-5-5')
    expect(row.estimatedEffort).toBe('high')
    expect(row.modelConfidence).toBe(0.75)
    expect(logs.join(' ')).not.toContain('Please review this implementation')
  })

  test('rejects an upstream option that was not offered', async () => {
    globalThis.fetch = async () =>
      Response.json({
        model: 'jeff-latest',
        answers: {
          complexity: {
            type: 'score',
            score: 0.5,
            confidence: 0.5,
            probabilities: { '0': 0.5, '1': 0.5 },
            legend: { '0': 'Simple', '1': 'Complex' }
          },
          modelEffort: { type: 'choice', choice: '99', confidence: 0.9, probabilities: { '99': 1 } }
        },
        usage: { input_tokens: 20, output_tokens: 0 }
      })
    shadowEvaluateSubagent({
      messages: [{ role: 'user', content: 'Please review the implementation' }],
      log,
      candidates: [{ target: 'claude-code,claude-sonnet-5-5', targetTier: 'sonnet', efforts: ['low', 'high'] }]
    })
    await flushShadow()
    const line = logs.at(-1)
    if (line === undefined) throw new Error('shadow result was not logged')
    const row = JSON.parse(line)
    expect(row.outcome).toBe('invalid_answer')
    expect(row.estimatedModel).toBeUndefined()
  })

  test('skips likely non-English, oversized, and mixed tool content', async () => {
    const calls: string[] = []
    globalThis.fetch = async (_url, options) => {
      calls.push(String(options?.body))
      return Response.json({})
    }
    await route(request('このコードを修正してください'))
    await route(request('Por favor, corrige el codigo'))
    await route(request(`Please fix ${'x'.repeat(2_001)}`))
    const mixed = request('Please fix this')
    mixed.body.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please fix this' },
          { type: 'tool_result', content: 'secret arguments' }
        ]
      }
    ]
    await route(mixed)
    await flushShadow()
    expect(calls).toHaveLength(0)
    expect(latestPlainTextInstruction(mixed.body.messages)).toBeNull()
  })
})

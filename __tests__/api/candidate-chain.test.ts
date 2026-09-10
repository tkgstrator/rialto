import { afterEach, expect, test } from 'bun:test'
import { buildFailoverChain } from '../../src/api/v1/candidate-chain'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import { clearModelExhaustion, markModelExhausted } from '../../src/services/failover-state'

// The fallback chain is resolved by the selector and threaded through
// the RoutePlan, so tests set it directly.
const plan = (over: Partial<RoutePlan>): RoutePlan =>
  ({
    routedBody: {},
    headers: {},
    transformersByName: new Map(),
    defaultTransformer: {},
    scenarioType: 'default',
    primaryModel: 'codex,gpt-5.6-luna',
    isSubagent: false,
    fallbacks: [],
    path: '/v1/messages',
    search: '',
    ...over
  }) as unknown as RoutePlan

afterEach(() => {
  clearModelExhaustion('codex', 'gpt-5.6-luna')
  clearModelExhaustion('gemini', 'g')
})

test('buildFailoverChain: appends the pre-resolved fallback chain after the primary', () => {
  const chain = buildFailoverChain(plan({ fallbacks: ['gemini,g'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'gemini,g'])
})

test('buildFailoverChain: a subagent request walks whatever chain the selector resolved', () => {
  // A subagent request gets its subagent-lane chain from the selector;
  // the reactive path just uses whatever plan.fallbacks carries — it
  // does not re-look-up by scenario/kind.
  const chain = buildFailoverChain(plan({ isSubagent: true, fallbacks: ['claude-code,claude-haiku'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'claude-code,claude-haiku'])
})

test('buildFailoverChain: same-provider fallbacks pass through (intra-account rescue)', () => {
  // Different models on the same provider used to be dropped
  // unconditionally. Now that exhaustion is tracked per (provider,
  // model), a Fable→Opus-style fallback on the same provider is a
  // legitimate configuration and stays in the chain.
  const chain = buildFailoverChain(plan({ fallbacks: ['codex,gpt-5.6-sol'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'codex,gpt-5.6-sol'])
})

test('buildFailoverChain: an empty fallback chain leaves just the primary', () => {
  const chain = buildFailoverChain(plan({ fallbacks: [] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna'])
})

test('buildFailoverChain: a subscription primary keeps its api_key fallbacks, in chain order', () => {
  // There used to be a same-auth_mode gate here that silently dropped
  // `openai` behind the `codex` subscription. The chain is the
  // operator's own ordering, and an entry they did not want after a
  // subscription would not be in it.
  const chain = buildFailoverChain(plan({ fallbacks: ['openai,gpt-5.6-luna', 'anthropic,claude-sonnet'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'openai,gpt-5.6-luna', 'anthropic,claude-sonnet'])
})

test('buildFailoverChain: a duplicate entry is walked once', () => {
  const chain = buildFailoverChain(plan({ fallbacks: ['gemini,g', 'codex,gpt-5.6-luna', 'gemini,g'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'gemini,g'])
})

test('buildFailoverChain: an exhausted entry is skipped while a live one remains', () => {
  markModelExhausted('codex', 'gpt-5.6-luna')
  const chain = buildFailoverChain(plan({ fallbacks: ['gemini,g'] }))
  expect(chain).toEqual(['gemini,g'])
})

test('buildFailoverChain: when every entry is exhausted the whole chain is still tried', () => {
  // The window may have reset since the mark was written; an empty
  // chain would refuse a request that might have gone through.
  markModelExhausted('codex', 'gpt-5.6-luna')
  markModelExhausted('gemini', 'g')
  const chain = buildFailoverChain(plan({ fallbacks: ['gemini,g'] }))
  expect(chain).toEqual(['codex,gpt-5.6-luna', 'gemini,g'])
})

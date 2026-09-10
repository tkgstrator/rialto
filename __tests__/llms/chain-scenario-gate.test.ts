/**
 * Scenario classification is gated on the chain.
 *
 * `classifyScenario` will not land on a scenario the chain cannot serve
 * — otherwise a heavy request with an empty `longContext` lane would
 * drop onto the caller's own model when the default lane could have
 * taken it. "Can serve" means a lane with at least one routable entry,
 * and the chain's own default model drives the longContext
 * auto-threshold for the same reason.
 */

import { expect, test } from 'bun:test'
import type { Logger } from 'pino'
import { chainRoutingOf } from '../../src/llms/quota-router/runtime'
import { type ChainRouting, classifyRequest, type RouterRequest } from '../../src/llms/scenario-router'
import { entry, profileWith } from './chain-fixture'

const noopLog = { info() {}, warn() {}, error() {} } as unknown as Logger
const makeReq = (body: Partial<RouterRequest['body']> & { model: string }): RouterRequest => ({
  body: body as RouterRequest['body'],
  log: noopLog
})

// The subagent marker is only read from the SECOND system block, which is
// where Claude Code puts it.
const subagentSystem = () => [
  { type: 'text', text: 'preamble' },
  { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x</RIALTO-SUBAGENT-MODEL>' }
]

const anthropic = {
  name: 'anthropic',
  api_base_url: 'https://api.anthropic.com',
  auth_mode: 'subscription',
  models: ['claude-opus', 'claude-sonnet', 'claude-think'],
  modelContextWindows: { 'claude-sonnet': 200_000 }
}

// ---- the gate itself -----------------------------------------------

test('classification: a think lane makes `think` reachable', () => {
  const chain = chainRoutingOf(profileWith({ 'think.agent': ['anthropic,claude-think'] }), [anthropic])
  const out = classifyRequest(
    makeReq({ model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }),
    1000,
    chain
  )
  expect(out.scenarioType).toBe('think')
})

test('classification: with no think lane the same request lands on default', () => {
  const chain = chainRoutingOf(profileWith({ 'default.agent': ['anthropic,claude-sonnet'] }), [anthropic])
  const out = classifyRequest(
    makeReq({ model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }),
    1000,
    chain
  )
  expect(out.scenarioType).toBe('default')
})

test('classification: a chain lane reaches webSearch and longContext too', () => {
  const chain = chainRoutingOf(
    profileWith({
      'webSearch.agent': ['anthropic,claude-sonnet'],
      'longContext.agent': ['anthropic,claude-opus']
    }),
    [anthropic]
  )
  const search = classifyRequest(
    makeReq({ model: 'claude-sonnet-4-5', tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
    1000,
    chain
  )
  expect(search.scenarioType).toBe('webSearch')

  const heavy = classifyRequest(makeReq({ model: 'claude-opus-4-5' }), 1000, chain)
  expect(heavy.scenarioType).toBe('longContext')
})

test('classification: the subagent lane is gated independently of the agent lane', () => {
  // A chain that fills only the agent think lane must not make the
  // subagent think lane reachable — the two chains are ordered (and
  // configured) separately, and the selector would find nothing.
  const chain = chainRoutingOf(profileWith({ 'think.agent': ['anthropic,claude-think'] }), [anthropic])
  const out = classifyRequest(
    makeReq({
      model: 'claude-sonnet-4-5',
      system: subagentSystem(),
      thinking: { type: 'enabled', budget_tokens: 1000 }
    }),
    1000,
    chain
  )
  expect(out.isSubagent).toBe(true)
  expect(out.scenarioType).toBe('default')
})

// ---- chainRoutingOf ------------------------------------------------

test('chainRoutingOf: a lane whose entries are all soft-disabled does not count as configured', () => {
  // The selector skips disabled entries, so such a lane resolves to no
  // primary — classifying into it is the failure the gate prevents.
  const chain = chainRoutingOf(profileWith({ 'think.agent': [entry('anthropic,claude-think', false)] }), [anthropic])
  expect(chain.hasLane('agent', 'think')).toBe(false)
})

test('chainRoutingOf: the default lane’s top enabled target supplies the auto-threshold window', () => {
  const chain = chainRoutingOf(profileWith({ 'default.agent': ['anthropic,claude-sonnet'] }), [anthropic])
  expect(chain.defaultAgentContextWindow).toBe(200_000)
})

test('chainRoutingOf: a disabled top entry is skipped for the window too', () => {
  const chain = chainRoutingOf(
    profileWith({ 'default.agent': [entry('anthropic,claude-opus', false), 'anthropic,claude-sonnet'] }),
    [anthropic]
  )
  expect(chain.defaultAgentContextWindow).toBe(200_000)
})

test('chainRoutingOf: an unscraped or unknown target leaves the window null', () => {
  const unknownModel = chainRoutingOf(profileWith({ 'default.agent': ['anthropic,claude-opus'] }), [anthropic])
  expect(unknownModel.defaultAgentContextWindow).toBeNull()

  const unknownProvider = chainRoutingOf(profileWith({ 'default.agent': ['nope,claude-sonnet'] }), [anthropic])
  expect(unknownProvider.defaultAgentContextWindow).toBeNull()

  const malformed = chainRoutingOf(profileWith({ 'default.agent': ['claude-sonnet'] }), [anthropic])
  expect(malformed.defaultAgentContextWindow).toBeNull()
})

test('chainRoutingOf: an empty profile serves no lane and pins nothing', () => {
  const chain = chainRoutingOf(profileWith({}), [anthropic])
  expect(chain.hasLane('agent', 'think')).toBe(false)
  expect(chain.hasLane('subagent', 'longContext')).toBe(false)
  expect(chain.defaultAgentContextWindow).toBeNull()
  expect(chain.longContextThreshold).toBeNull()
})

test('chainRoutingOf: the profile constraint threshold is carried through', () => {
  const chain = chainRoutingOf(profileWith({}, { longContextThreshold: 60_000 }), [anthropic])
  expect(chain.longContextThreshold).toBe(60_000)
})

test('chainRoutingOf: a constraint blob that fails to parse falls back to the defaults', () => {
  const chain = chainRoutingOf(profileWith({}, { longContextThreshold: -5 }), [anthropic])
  expect(chain.longContextThreshold).toBeNull()
})

// ---- the longContext threshold -------------------------------------

const lanesWithLongContext = {
  'default.agent': ['anthropic,claude-sonnet'],
  'longContext.agent': ['anthropic,claude-opus']
}

const lightRequest = () => makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } })

test('threshold: the profile constraint wins over the chain’s window', () => {
  const chain = chainRoutingOf(profileWith(lanesWithLongContext, { longContextThreshold: 60_000 }), [anthropic])
  expect(classifyRequest(lightRequest(), 59_000, chain).scenarioType).toBe('default')
  expect(classifyRequest(lightRequest(), 70_000, chain).scenarioType).toBe('longContext')
})

test('threshold: with no constraint, the chain’s default model drives the auto-threshold', () => {
  // 200k × 0.7 = 140k, so 130k must stay on `default`.
  const chain: ChainRouting = chainRoutingOf(profileWith(lanesWithLongContext), [anthropic])
  expect(classifyRequest(lightRequest(), 130_000, chain).scenarioType).toBe('default')
  expect(classifyRequest(lightRequest(), 141_000, chain).scenarioType).toBe('longContext')
})

test('threshold: with no constraint and no window, 128k is the floor', () => {
  const noWindow = { ...anthropic, modelContextWindows: {} }
  const chain = chainRoutingOf(profileWith(lanesWithLongContext), [noWindow])
  expect(classifyRequest(lightRequest(), 127_000, chain).scenarioType).toBe('default')
  expect(classifyRequest(lightRequest(), 130_000, chain).scenarioType).toBe('longContext')
})

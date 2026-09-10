import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Logger } from 'pino'
import { chainRoutingOf } from '../../src/llms/quota-router/runtime'
import { ConfigStore } from '../../src/llms/registry/config'
import {
  applyProactiveFailover,
  candidateUsable,
  classifyRequest,
  isHeavyRequest,
  type RouterRequest
} from '../../src/llms/scenario-router'
import { clearProviderExhaustion, markProviderExhausted } from '../../src/services/failover-state'
import { profileWith } from './chain-fixture'

// A no-op logger stub — the router only calls log.info, and the test does
// not assert on log output. Index 5 is the `log` param of the
// applyProactiveFailover(primaryModel, scenarioType, fallbacks, tokenCount,
// config, log) signature.
const noopLog = {
  info() {},
  warn() {},
  error() {}
} as unknown as Parameters<typeof applyProactiveFailover>[5]

const claudeProvider = {
  name: 'anthropic',
  api_base_url: 'https://api.anthropic.com',
  auth_mode: 'subscription',
  models: ['claude-opus', 'claude-sonnet']
}
const codexProvider = {
  name: 'codex',
  api_base_url: 'https://chatgpt.com/backend-api',
  auth_mode: 'subscription',
  models: ['gpt-5']
}

beforeEach(() => {
  clearProviderExhaustion('anthropic')
  clearProviderExhaustion('codex')
})

afterEach(() => {
  clearProviderExhaustion('anthropic')
  clearProviderExhaustion('codex')
})

// ---- candidateUsable: exhaustion mark ------------------------------

test('candidateUsable: an unmarked provider is usable', () => {
  expect(candidateUsable('anthropic')).toBe(true)
  expect(candidateUsable('codex')).toBe(true)
})

test('candidateUsable: a provider marked exhausted by the reactive 429 path is unusable', () => {
  markProviderExhausted('anthropic')
  expect(candidateUsable('anthropic')).toBe(false)
})

test('candidateUsable: clearing the mark restores usability', () => {
  markProviderExhausted('anthropic')
  clearProviderExhaustion('anthropic')
  expect(candidateUsable('anthropic')).toBe(true)
})

// ---- applyProactiveFailover: chain walk on exhaustion --------------

// The fallback chain is passed explicitly to applyProactiveFailover, so
// the config only needs the providers registry.
const providersOnly = (): ConfigStore => new ConfigStore({ providers: [claudeProvider, codexProvider] })

test('applyProactiveFailover: keeps the primary when nothing is exhausted', () => {
  const out = applyProactiveFailover(
    'anthropic,claude-opus',
    'default',
    ['codex,gpt-5'],
    1000,
    providersOnly(),
    noopLog
  )
  expect(out).toBe('anthropic,claude-opus')
})

test('applyProactiveFailover: falls over to the next candidate when the primary is exhausted', () => {
  markProviderExhausted('anthropic')
  const out = applyProactiveFailover(
    'anthropic,claude-opus',
    'default',
    ['codex,gpt-5'],
    1000,
    providersOnly(),
    noopLog
  )
  expect(out).toBe('codex,gpt-5')
})

// ---- capability gate (contextWindow) -------------------------------

test('applyProactiveFailover: skips a candidate whose model cannot fit the request', () => {
  const config = new ConfigStore({
    providers: [
      {
        ...codexProvider,
        models: ['gpt-5', 'gpt-5-big'],
        modelContextWindows: { 'gpt-5': 8000, 'gpt-5-big': 200000 }
      }
    ]
  })
  const out = applyProactiveFailover('codex,gpt-5', 'default', ['codex,gpt-5-big'], 9000, config, noopLog)
  expect(out).toBe('codex,gpt-5-big')
})

test('applyProactiveFailover: a candidate fits when the request is within its declared window', () => {
  const config = new ConfigStore({
    providers: [
      {
        ...codexProvider,
        models: ['gpt-5', 'gpt-5-big'],
        modelContextWindows: { 'gpt-5': 8000, 'gpt-5-big': 200000 }
      }
    ]
  })
  const out = applyProactiveFailover('codex,gpt-5', 'default', ['codex,gpt-5-big'], 7000, config, noopLog)
  expect(out).toBe('codex,gpt-5')
})

test('applyProactiveFailover: a model with no declared window is allowed (unknown = allow)', () => {
  markProviderExhausted('anthropic')
  const out = applyProactiveFailover(
    'anthropic,claude-opus',
    'default',
    ['codex,gpt-5'],
    5_000_000,
    providersOnly(),
    noopLog
  )
  expect(out).toBe('codex,gpt-5')
})

// ---- effort / tier grading (S0.5) ----------------------------------

test('isHeavyRequest: high/xhigh/max effort grades as heavy', () => {
  expect(isHeavyRequest({ model: 'claude-sonnet', output_config: { effort: 'high' } })).toBe(true)
  expect(isHeavyRequest({ model: 'claude-sonnet', output_config: { effort: 'xhigh' } })).toBe(true)
  expect(isHeavyRequest({ model: 'claude-sonnet', output_config: { effort: 'max' } })).toBe(true)
})

test('isHeavyRequest: low/medium effort grades as light even when the model is opus', () => {
  expect(isHeavyRequest({ model: 'claude-opus', output_config: { effort: 'low' } })).toBe(false)
  expect(isHeavyRequest({ model: 'claude-opus', output_config: { effort: 'medium' } })).toBe(false)
})

test('isHeavyRequest: tier fallback kicks in when effort is absent', () => {
  expect(isHeavyRequest({ model: 'claude-opus-4-5' })).toBe(true)
  expect(isHeavyRequest({ model: 'claude-sonnet-4-5' })).toBe(false)
  expect(isHeavyRequest({ model: 'claude-haiku-4-5' })).toBe(false)
  expect(isHeavyRequest({ model: 'gpt-5' })).toBe(false)
})

test('isHeavyRequest: an unparseable effort string falls through to tier', () => {
  expect(isHeavyRequest({ model: 'claude-opus', output_config: { effort: 'whatever' } })).toBe(true)
  expect(isHeavyRequest({ model: 'claude-sonnet', output_config: { effort: 'whatever' } })).toBe(false)
})

const log = noopLog as unknown as Logger
const makeReq = (body: Partial<RouterRequest['body']> & { model: string }): RouterRequest => ({
  body: body as RouterRequest['body'],
  log
})

// ---- classifyRequest: scenario classification (agent lane) ---------
//
// Each case names the lanes the chain serves; the classifier is asked
// which one the request lands on, and nothing else — picking the model
// inside the lane is the selector's job.

const DEFAULT_ONLY = { 'default.agent': ['anthropic,claude-sonnet'] }
const WITH_LONG = { ...DEFAULT_ONLY, 'longContext.agent': ['anthropic,claude-opus'] }
const WITH_LONG_AND_THINK = { ...WITH_LONG, 'think.agent': ['anthropic,claude-think'] }

const classify = (
  lanes: Record<string, string[]>,
  body: Partial<RouterRequest['body']> & { model: string },
  tokenCount = 1000,
  constraints: Record<string, unknown> | null = null
) => classifyRequest(makeReq(body), tokenCount, chainRoutingOf(profileWith(lanes, constraints), [claudeProvider]))

test('classifyRequest: heavy effort escalates a short request into the longContext lane', () => {
  const out = classify(WITH_LONG_AND_THINK, { model: 'claude-sonnet-future', output_config: { effort: 'high' } })
  expect(out).toEqual({ scenarioType: 'longContext', isSubagent: false })
})

test('classifyRequest: opus-tier requested model escalates to longContext when effort is absent', () => {
  expect(classify(WITH_LONG, { model: 'claude-opus-4-5' })).toEqual({ scenarioType: 'longContext', isSubagent: false })
})

test('classifyRequest: low effort keeps an opus request on the default lane', () => {
  const out = classify(WITH_LONG, { model: 'claude-opus-4-5', output_config: { effort: 'low' } })
  expect(out).toEqual({ scenarioType: 'default', isSubagent: false })
})

test('classifyRequest: a sonnet request without heavy signals stays on default', () => {
  expect(classify(WITH_LONG, { model: 'claude-sonnet-4-5' })).toEqual({ scenarioType: 'default', isSubagent: false })
})

test('classifyRequest: thinking field wins over the effort/tier escalation', () => {
  const out = classify(WITH_LONG_AND_THINK, {
    model: 'claude-opus-4-5',
    thinking: { type: 'enabled', budget_tokens: 1000 }
  })
  expect(out).toEqual({ scenarioType: 'think', isSubagent: false })
})

test('classifyRequest: thinking:{type:"disabled"} stays on the default lane (regression: was truthy, routed to think)', () => {
  // Claude Code sends `{type: 'disabled'}` on every non-Plan-Mode
  // request. Before the fix, the classifier treated the object as
  // truthy and silently routed all traffic to the `think` lane — a
  // large silent cost regression on any config where `think` points
  // at Opus. `{type: 'disabled'}` must NOT trigger the think lane.
  const out = classify(WITH_LONG_AND_THINK, { model: 'claude-sonnet-4-5', thinking: { type: 'disabled' } })
  expect(out.scenarioType).toBe('default')
})

test('classifyRequest: thinking:{type:"adaptive"} routes to think (newer Claude Code opus/sonnet builds)', () => {
  // Opus 4-7 / Sonnet 4-6 send `{type: 'adaptive'}` — the client
  // explicitly opts into adaptive thinking (the model decides at
  // runtime whether to think). Distinct from omitting the field:
  // Anthropic falls back to adaptive server-side on absence, but
  // the router treats presence with a non-disabled type as the
  // client's opt-in signal.
  const out = classify(WITH_LONG_AND_THINK, { model: 'claude-opus-4-7', thinking: { type: 'adaptive' } })
  expect(out.scenarioType).toBe('think')
})

test('classifyRequest: size-based longContext still wins when the request exceeds the threshold', () => {
  const out = classify(WITH_LONG, { model: 'claude-sonnet-future', output_config: { effort: 'low' } }, 100_000, {
    longContextThreshold: 60_000
  })
  expect(out).toEqual({ scenarioType: 'longContext', isSubagent: false })
})

test('classifyRequest: heavy escalation no-ops when the agent longContext lane is empty', () => {
  const out = classify(DEFAULT_ONLY, { model: 'claude-opus-4-5', output_config: { effort: 'high' } })
  expect(out).toEqual({ scenarioType: 'default', isSubagent: false })
})

// ---- classifyRequest: subagent lane (tag presence, not value) ------

test('classifyRequest: a <RIALTO-SUBAGENT-MODEL> tag selects the subagent lane (value ignored, tag stripped)', () => {
  // The tag PRESENCE picks the subagent lane; the tag VALUE
  // (anthropic,claude-fable) is NOT used to route. The tag is stripped so
  // the marker never leaks upstream.
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: 'You are a subagent.' },
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anthropic,claude-fable</RIALTO-SUBAGENT-MODEL>' }
    ]
  })
  const chain = chainRoutingOf(profileWith({ ...DEFAULT_ONLY, 'default.subagent': ['anthropic,claude-sonnet'] }), [
    claudeProvider
  ])
  expect(classifyRequest(req, 1000, chain)).toEqual({ scenarioType: 'default', isSubagent: true })
  // Tag stripped from the outgoing system prompt.
  const system = req.body.system as { text: string }[]
  expect(system[1].text).toBe('')
})

test('classifyRequest: the subagent lane classifies scenarios independently of the agent lane', () => {
  // A subagent request with heavy effort escalates on the subagent
  // longContext lane — the agent longContext lane is not consulted.
  const lanes = {
    ...DEFAULT_ONLY,
    'default.subagent': ['anthropic,claude-sonnet'],
    'longContext.subagent': ['anthropic,claude-opus']
  }
  const out = classify(lanes, {
    model: 'claude-opus-4-5',
    output_config: { effort: 'high' },
    system: [
      { type: 'text', text: 'sys' },
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
    ]
  })
  expect(out).toEqual({ scenarioType: 'longContext', isSubagent: true })
})

test('classifyRequest: an unclosed subagent tag still selects the subagent lane (present, not stripped)', () => {
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: 'sys' },
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anthropic,x' }
    ]
  })
  const chain = chainRoutingOf(profileWith(DEFAULT_ONLY), [claudeProvider])
  expect(classifyRequest(req, 1000, chain).isSubagent).toBe(true)
  // Unclosed tag is left untouched (only a well-formed tag is stripped).
  const system = req.body.system as { text: string }[]
  expect(system[1].text).toBe('<RIALTO-SUBAGENT-MODEL>anthropic,x')
})

test('classifyRequest: a tag outside the second system block is ignored (agent lane)', () => {
  const out = classify(DEFAULT_ONLY, {
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' },
      { type: 'text', text: 'sys' }
    ]
  })
  expect(out.isSubagent).toBe(false)
})

test('classifyRequest: a single-block system cannot carry the tag (agent lane)', () => {
  const out = classify(DEFAULT_ONLY, {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }]
  })
  expect(out.isSubagent).toBe(false)
})

// ---- applyProactiveFailover: whatever chain the caller supplies -----

test('applyProactiveFailover: walks whatever fallback chain the caller supplies (agent)', () => {
  markProviderExhausted('anthropic')
  const config = new ConfigStore({
    providers: [claudeProvider, { ...codexProvider, models: ['gpt-5-agent', 'gpt-5-sub'] }]
  })
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5-agent'], 1000, config, noopLog)
  expect(out).toBe('codex,gpt-5-agent')
})

test('applyProactiveFailover: subagent chain is just a different explicit list', () => {
  markProviderExhausted('anthropic')
  const config = new ConfigStore({
    providers: [claudeProvider, { ...codexProvider, models: ['gpt-5-agent', 'gpt-5-sub'] }]
  })
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5-sub'], 1000, config, noopLog)
  expect(out).toBe('codex,gpt-5-sub')
})

// ---- regression / chain decision -----------------------------------

test('applyProactiveFailover: keeps the primary when every candidate is exhausted', () => {
  markProviderExhausted('anthropic')
  markProviderExhausted('codex')
  const captured: { msg: string; obj: Record<string, unknown> }[] = []
  const log = {
    info: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    warn: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    error: () => {}
  } as unknown as Parameters<typeof applyProactiveFailover>[5]

  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, providersOnly(), log)

  expect(out).toBe('anthropic,claude-opus')
  const warn = captured.find((c) => c.msg.includes('all candidates rejected'))
  expect(warn).toBeDefined()
  const trace = warn?.obj.trace as { candidate: string; reason: string }[]
  expect(trace).toEqual([
    { candidate: 'anthropic,claude-opus', reason: 'exhausted' },
    { candidate: 'codex,gpt-5', reason: 'exhausted' }
  ])
})

test('applyProactiveFailover: trace records the chain walk on a successful fail-over', () => {
  markProviderExhausted('anthropic')
  const captured: { msg: string; obj: Record<string, unknown> }[] = []
  const log = {
    info: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    warn: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    error: () => {}
  } as unknown as Parameters<typeof applyProactiveFailover>[5]

  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, providersOnly(), log)
  expect(out).toBe('codex,gpt-5')
  const info = captured.find((c) => c.msg.includes('primary dropped'))
  const trace = info?.obj.trace as { candidate: string; reason: string }[]
  expect(trace).toEqual([
    { candidate: 'anthropic,claude-opus', reason: 'exhausted' },
    { candidate: 'codex,gpt-5', reason: 'kept' }
  ])
})

test('applyProactiveFailover: capability-gate skips are recorded in the trace', () => {
  const captured: { msg: string; obj: Record<string, unknown> }[] = []
  const log = {
    info: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    warn: (obj: Record<string, unknown>, msg: string) => captured.push({ msg, obj }),
    error: () => {}
  } as unknown as Parameters<typeof applyProactiveFailover>[5]

  const config = new ConfigStore({
    providers: [{ ...codexProvider, models: ['small', 'big'], modelContextWindows: { small: 1000, big: 200_000 } }]
  })
  const out = applyProactiveFailover('codex,small', 'default', ['codex,big'], 5_000, config, log)
  expect(out).toBe('codex,big')
  const info = captured.find((c) => c.msg.includes('primary dropped'))
  const trace = info?.obj.trace as { candidate: string; reason: string }[]
  expect(trace).toEqual([
    { candidate: 'codex,small', reason: 'capability' },
    { candidate: 'codex,big', reason: 'kept' }
  ])
})

// ---- classifyRequest: webSearch lane -------------------------------

const WITH_SEARCH = { ...DEFAULT_ONLY, 'webSearch.agent': ['anthropic,claude-sonnet'] }

test('classifyRequest: a web_search tool routes to the webSearch lane', () => {
  const out = classify(WITH_SEARCH, { model: 'claude-sonnet-4-5', tools: [{ type: 'web_search_20250305' }] })
  expect(out).toEqual({ scenarioType: 'webSearch', isSubagent: false })
})

test('classifyRequest: webSearch wins over thinking when both are present', () => {
  const out = classify(
    { ...WITH_SEARCH, 'think.agent': ['anthropic,claude-think'] },
    {
      model: 'claude-sonnet-4-5',
      tools: [{ type: 'web_search_20250305' }],
      thinking: { type: 'enabled', budget_tokens: 1000 }
    }
  )
  expect(out).toEqual({ scenarioType: 'webSearch', isSubagent: false })
})

// ---- classifyRequest: unconfigured lanes fall through to default ---

test('classifyRequest: a web_search tool falls through to default when the webSearch lane is empty', () => {
  const out = classify(DEFAULT_ONLY, { model: 'claude-sonnet-4-5', tools: [{ type: 'web_search_20250305' }] })
  expect(out).toEqual({ scenarioType: 'default', isSubagent: false })
})

test('classifyRequest: thinking falls through to default when the think lane is empty', () => {
  const out = classify(DEFAULT_ONLY, {
    model: 'claude-sonnet-4-5',
    thinking: { type: 'enabled', budget_tokens: 1000 }
  })
  expect(out).toEqual({ scenarioType: 'default', isSubagent: false })
})

test('classifyRequest: a haiku model with no signals lands on default', () => {
  expect(classify(DEFAULT_ONLY, { model: 'claude-haiku-4-5' })).toEqual({ scenarioType: 'default', isSubagent: false })
})

test('classifyRequest: an oversized request falls through to default when the longContext lane is empty', () => {
  const out = classify(DEFAULT_ONLY, { model: 'claude-sonnet-4-5' }, 100_000, { longContextThreshold: 60_000 })
  expect(out).toEqual({ scenarioType: 'default', isSubagent: false })
})

// ---- classifyRequest: scenario precedence --------------------------

test('classifyRequest: size-based longContext wins for a haiku request too', () => {
  const out = classify(WITH_LONG, { model: 'claude-haiku-4-5' }, 100_000, { longContextThreshold: 60_000 })
  expect(out).toEqual({ scenarioType: 'longContext', isSubagent: false })
})

test('classifyRequest: thinking picks the think lane regardless of the requested model', () => {
  const out = classify(
    { ...DEFAULT_ONLY, 'think.agent': ['anthropic,claude-think'] },
    { model: 'claude-haiku-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }
  )
  expect(out).toEqual({ scenarioType: 'think', isSubagent: false })
})

// ---- classifyRequest: subagent lane classifies independently -------

test('classifyRequest: a subagent web_search request uses the subagent webSearch lane', () => {
  const out = classify(
    {
      ...WITH_SEARCH,
      'default.subagent': ['anthropic,claude-sonnet'],
      'webSearch.subagent': ['anthropic,claude-opus']
    },
    {
      model: 'claude-sonnet-4-5',
      tools: [{ type: 'web_search_20250305' }],
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }
  )
  expect(out).toEqual({ scenarioType: 'webSearch', isSubagent: true })
})

test('classifyRequest: an empty subagent lane falls through even when the agent lane for that scenario is set', () => {
  // webSearch is configured for the AGENT lane only. A subagent
  // web_search request finds no subagent webSearch lane, so it falls
  // through to the subagent default.
  const out = classify(
    { ...WITH_SEARCH, 'default.subagent': ['anthropic,claude-sonnet'] },
    {
      model: 'claude-sonnet-4-5',
      tools: [{ type: 'web_search_20250305' }],
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }
  )
  expect(out).toEqual({ scenarioType: 'default', isSubagent: true })
})

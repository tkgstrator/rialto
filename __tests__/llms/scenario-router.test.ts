import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Logger } from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import {
  applyProactiveFailover,
  candidateUsable,
  isHeavyRequest,
  type RouterRequest,
  selectModel
} from '../../src/llms/scenario-router'
import { clearProviderExhaustion, markProviderExhausted } from '../../src/services/failover-state'

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

// Build a ConfigStore whose flat Router carries an agent default primary.
// The fallback chain is now passed explicitly to applyProactiveFailover
// (rather than looked up by scenario), so the config only needs the
// primary and the providers registry.
const routerWith = (_fallbacks: string[]): ConfigStore =>
  new ConfigStore({
    Router: { agent: { default: 'anthropic,claude-opus' } },
    providers: [claudeProvider, codexProvider]
  })

test('applyProactiveFailover: keeps the primary when nothing is exhausted', () => {
  const config = routerWith(['codex,gpt-5'])
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, config, noopLog)
  expect(out).toBe('anthropic,claude-opus')
})

test('applyProactiveFailover: falls over to the next candidate when the primary is exhausted', () => {
  markProviderExhausted('anthropic')
  const config = routerWith(['codex,gpt-5'])
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, config, noopLog)
  expect(out).toBe('codex,gpt-5')
})

// ---- capability gate (contextWindow) -------------------------------

test('applyProactiveFailover: skips a candidate whose model cannot fit the request', () => {
  const config = new ConfigStore({
    Router: { agent: { default: 'codex,gpt-5' } },
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
    Router: { agent: { default: 'codex,gpt-5' } },
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
  const config = routerWith(['codex,gpt-5'])
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 5_000_000, config, noopLog)
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

// ---- selectModel: scenario classification (agent route) ------------

test('selectModel: heavy effort escalates a short request into the longContext lane', () => {
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus', think: 'anthropic,claude-opus' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'high' } }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-opus', scenarioType: 'longContext', isSubagent: false, fallbacks: [] })
})

test('selectModel: opus-tier requested model escalates to longContext when effort is absent', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-opus-4-5' }), 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-opus', scenarioType: 'longContext', isSubagent: false, fallbacks: [] })
})

test('selectModel: low effort keeps an opus request on the default (Sonnet) lane', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-opus-4-5', output_config: { effort: 'low' } }), 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: a sonnet request without heavy signals stays on default', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5' }), 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: thinking field wins over the effort/tier escalation', () => {
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus', think: 'anthropic,claude-think' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-opus-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-think', scenarioType: 'think', isSubagent: false, fallbacks: [] })
})

test('selectModel: thinking:{type:"disabled"} stays on the default lane (regression: was truthy, routed to think)', () => {
  // Claude Code sends `{type: 'disabled'}` on every non-Plan-Mode
  // request. Before the fix, the classifier treated the object as
  // truthy and silently routed all traffic to the `think` slot — a
  // large silent cost regression on any config where `think` points
  // at Opus. `{type: 'disabled'}` must NOT trigger the think lane.
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus', think: 'anthropic,claude-think' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5', thinking: { type: 'disabled' } }), 1000, router, config)
  expect(out.scenarioType).toBe('default')
  expect(out.model).toBe('anthropic,claude-sonnet')
})

test('selectModel: thinking:{type:"adaptive"} routes to think (newer Claude Code opus/sonnet builds)', () => {
  // Opus 4-7 / Sonnet 4-6 send `{type: 'adaptive'}` — the client
  // explicitly opts into adaptive thinking (the model decides at
  // runtime whether to think). Distinct from omitting the field:
  // Anthropic falls back to adaptive server-side on absence, but
  // the router treats presence with a non-disabled type as the
  // client's opt-in signal. The router must not accidentally
  // exclude adaptive when tightening the disabled-truthy bug —
  // {enabled, adaptive} both route to think.
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus', think: 'anthropic,claude-think' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-opus-4-7', thinking: { type: 'adaptive' } }), 1000, router, config)
  expect(out.scenarioType).toBe('think')
  expect(out.model).toBe('anthropic,claude-think')
})

test('selectModel: size-based longContext still wins when the request exceeds the threshold', () => {
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' },
    longContextThreshold: 60_000
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } }),
    100_000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-opus', scenarioType: 'longContext', isSubagent: false, fallbacks: [] })
})

test('selectModel: auto threshold uses 70% of the default primary contextWindow when longContextThreshold is null', () => {
  // Auto path: null threshold + a 200k default primary window → the
  // effective threshold is floor(200_000 * 0.7) = 140_000. A request
  // just under the auto value stays on `default`; a request above it
  // rolls to longContext.
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' },
    longContextThreshold: null,
    defaultAgentContextWindow: 200_000
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const under = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } }),
    139_000,
    router,
    config
  )
  expect(under.scenarioType).toBe('default')
  const over = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } }),
    141_000,
    router,
    config
  )
  expect(over.scenarioType).toBe('longContext')
})

test('selectModel: auto threshold falls back to 128k when no defaultAgentContextWindow is available', () => {
  // Per-project override files never populate defaultAgentContextWindow;
  // in that case the auto path degrades to the historical 128k fallback
  // so behaviour matches the pre-auto default exactly.
  const router = {
    agent: { default: 'anthropic,claude-sonnet', longContext: 'anthropic,claude-opus' },
    longContextThreshold: null
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const under = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } }),
    127_000,
    router,
    config
  )
  expect(under.scenarioType).toBe('default')
  const over = selectModel(
    makeReq({ model: 'claude-sonnet-future', output_config: { effort: 'low' } }),
    130_000,
    router,
    config
  )
  expect(over.scenarioType).toBe('longContext')
})

test('selectModel: heavy escalation no-ops when the agent longContext route is unset', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-opus-4-5', output_config: { effort: 'high' } }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

// ---- selectModel: subagent route (tag presence, not value) ---------

test('selectModel: a <RIALTO-SUBAGENT-MODEL> tag selects the subagent route (value ignored, tag stripped)', () => {
  // The tag PRESENCE picks the scenario's subagent primary; the tag VALUE
  // (anthropic,claude-fable) is NOT used to route. The tag is stripped so
  // the marker never leaks upstream.
  const router = {
    agent: { default: 'anthropic,claude-agent' },
    subagent: { default: 'anthropic,claude-subagent' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: 'You are a subagent.' },
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anthropic,claude-fable</RIALTO-SUBAGENT-MODEL>' }
    ]
  })
  const out = selectModel(req, 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-subagent', scenarioType: 'default', isSubagent: true, fallbacks: [] })
  // Tag stripped from the outgoing system prompt.
  const system = req.body.system as { text: string }[]
  expect(system[1].text).toBe('')
})

test('selectModel: the subagent route classifies scenarios independently of the agent route', () => {
  // A subagent request with heavy effort escalates to the subagent
  // longContext primary — the agent longContext primary is not consulted.
  const router = {
    agent: { default: 'anthropic,claude-agent', longContext: 'anthropic,claude-agent-opus' },
    subagent: { default: 'anthropic,claude-sub', longContext: 'anthropic,claude-sub-opus' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({
      model: 'claude-opus-4-5',
      output_config: { effort: 'high' },
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }),
    1000,
    router,
    config
  )
  expect(out).toEqual({
    model: 'anthropic,claude-sub-opus',
    scenarioType: 'longContext',
    isSubagent: true,
    fallbacks: []
  })
})

// ---- selectModel: chosen route primary null → req.body.model -------

test('selectModel: falls back to the request model when the chosen agent route has no primary', () => {
  // The agent route has no default primary configured, so the request's
  // own model is used verbatim (scenario default).
  const router = { agent: {} }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5' }), 1000, router, config)
  expect(out).toEqual({ model: 'claude-sonnet-4-5', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: falls back to the request model when the chosen subagent route has no primary', () => {
  // Tag present → subagent route, but no subagent primary configured, so
  // the request's own model is used verbatim.
  const router = { agent: { default: 'anthropic,claude-agent' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({
      model: 'claude-sonnet-4-5',
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'claude-sonnet-4-5', scenarioType: 'default', isSubagent: true, fallbacks: [] })
})

// ---- applyProactiveFailover: chosen route's fallback chain ----------

test('applyProactiveFailover: walks whatever fallback chain the caller supplies (agent)', () => {
  markProviderExhausted('anthropic')
  const config = new ConfigStore({
    Router: { agent: { default: 'anthropic,claude-opus' } },
    providers: [claudeProvider, { ...codexProvider, models: ['gpt-5-agent', 'gpt-5-sub'] }]
  })
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5-agent'], 1000, config, noopLog)
  expect(out).toBe('codex,gpt-5-agent')
})

test('applyProactiveFailover: subagent chain is just a different explicit list', () => {
  markProviderExhausted('anthropic')
  const config = new ConfigStore({
    Router: { agent: { default: 'anthropic,claude-opus' } },
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

  const config = routerWith(['codex,gpt-5'])
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, config, log)

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

  const config = routerWith(['codex,gpt-5'])
  const out = applyProactiveFailover('anthropic,claude-opus', 'default', ['codex,gpt-5'], 1000, config, log)
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
    Router: { agent: { default: 'codex,small' } },
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

// ---- selectModel: webSearch lane -----------------------------------

test('selectModel: a web_search tool routes to the webSearch lane', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet', webSearch: 'anthropic,claude-search' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-sonnet-4-5', tools: [{ type: 'web_search_20250305' }] }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-search', scenarioType: 'webSearch', isSubagent: false, fallbacks: [] })
})

test('selectModel: webSearch wins over thinking when both are present', () => {
  const router = {
    agent: {
      default: 'anthropic,claude-sonnet',
      webSearch: 'anthropic,claude-search',
      think: 'anthropic,claude-think'
    }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({
      model: 'claude-sonnet-4-5',
      tools: [{ type: 'web_search_20250305' }],
      thinking: { type: 'enabled', budget_tokens: 1000 }
    }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-search', scenarioType: 'webSearch', isSubagent: false, fallbacks: [] })
})

// ---- selectModel: unconfigured lanes fall through to default -------

test('selectModel: a web_search tool falls through to default when the webSearch route is unset', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-sonnet-4-5', tools: [{ type: 'web_search_20250305' }] }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: thinking falls through to default when the think route is unset', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({ model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: a haiku model falls through to default when the background route is unset', () => {
  const provider = { ...claudeProvider, models: ['claude-haiku-4-5'] }
  const router = { agent: { default: 'anthropic,claude-sonnet' } }
  const config = new ConfigStore({ Router: router, providers: [provider] })
  const out = selectModel(makeReq({ model: 'claude-haiku-4-5' }), 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: an oversized request falls through to default when the longContext route is unset', () => {
  const router = { agent: { default: 'anthropic,claude-sonnet' }, longContextThreshold: 60_000 }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5' }), 100_000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-sonnet', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

// ---- selectModel: scenario precedence ------------------------------

test('selectModel: size-based longContext wins over haiku→background', () => {
  const provider = { ...claudeProvider, models: ['claude-haiku-4-5'] }
  const router = {
    agent: {
      default: 'anthropic,claude-sonnet',
      longContext: 'anthropic,claude-opus',
      background: 'anthropic,claude-bg'
    },
    longContextThreshold: 60_000
  }
  const config = new ConfigStore({ Router: router, providers: [provider] })
  const out = selectModel(makeReq({ model: 'claude-haiku-4-5' }), 100_000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-opus', scenarioType: 'longContext', isSubagent: false, fallbacks: [] })
})

test('selectModel: thinking picks the think lane regardless of the requested model', () => {
  // The pre-rules "background wins over thinking" semantic was a
  // side-effect of an isHaiku→background classifier branch running ahead
  // of the thinking check. Both are gone: the classifier picks `think`
  // because thinking is set, and the lane's own primary serves it. There
  // is no predicate stack left that could divert it.
  const provider = { ...claudeProvider, models: ['claude-haiku-4-5'] }
  const router = {
    agent: {
      default: 'anthropic,claude-sonnet',
      think: 'anthropic,claude-think'
    }
  }
  const config = new ConfigStore({ Router: router, providers: [provider] })
  const out = selectModel(
    makeReq({ model: 'claude-haiku-4-5', thinking: { type: 'enabled', budget_tokens: 1000 } }),
    1000,
    router,
    config
  )
  expect(out).toEqual({
    model: 'anthropic,claude-think',
    scenarioType: 'think',
    isSubagent: false,
    fallbacks: []
  })
})

// ---- selectModel: configured = override (Force), unset = passthrough

test('selectModel: a configured primary overrides the request model (Force behavior)', () => {
  // The request asks for one model; the default lane is configured to
  // another. Routing uses the configured primary and ignores req.body.model.
  const router = { agent: { default: 'anthropic,claude-opus' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'someprovider,somemodel' }), 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-opus', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: an empty-string primary is treated as unset (request model passthrough)', () => {
  const router = { agent: { default: '' } }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5' }), 1000, router, config)
  expect(out).toEqual({ model: 'claude-sonnet-4-5', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: an undefined router routes to default with the request model passthrough', () => {
  const config = new ConfigStore({ Router: {}, providers: [claudeProvider] })
  const out = selectModel(makeReq({ model: 'claude-sonnet-4-5' }), 1000, undefined, config)
  expect(out).toEqual({ model: 'claude-sonnet-4-5', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

// ---- selectModel: subagent-tag boundary cases ----------------------

test('selectModel: an unclosed subagent tag still selects the subagent route (present, not stripped)', () => {
  const router = {
    agent: { default: 'anthropic,claude-agent' },
    subagent: { default: 'anthropic,claude-sub' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: 'sys' },
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>anthropic,x' }
    ]
  })
  const out = selectModel(req, 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-sub', scenarioType: 'default', isSubagent: true, fallbacks: [] })
  // Unclosed tag is left untouched (only a well-formed tag is stripped).
  const system = req.body.system as { text: string }[]
  expect(system[1].text).toBe('<RIALTO-SUBAGENT-MODEL>anthropic,x')
})

test('selectModel: a tag outside the second system block is ignored (agent route)', () => {
  const router = {
    agent: { default: 'anthropic,claude-agent' },
    subagent: { default: 'anthropic,claude-sub' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [
      { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' },
      { type: 'text', text: 'sys' }
    ]
  })
  const out = selectModel(req, 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-agent', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

test('selectModel: a single-block system cannot carry the tag (agent route)', () => {
  const router = {
    agent: { default: 'anthropic,claude-agent' },
    subagent: { default: 'anthropic,claude-sub' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const req = makeReq({
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }]
  })
  const out = selectModel(req, 1000, router, config)
  expect(out).toEqual({ model: 'anthropic,claude-agent', scenarioType: 'default', isSubagent: false, fallbacks: [] })
})

// ---- selectModel: subagent lane classifies independently -----------

test('selectModel: a subagent web_search request uses the subagent webSearch route', () => {
  const router = {
    agent: { default: 'anthropic,claude-agent', webSearch: 'anthropic,claude-agent-search' },
    subagent: { default: 'anthropic,claude-sub', webSearch: 'anthropic,claude-sub-search' }
  }
  const config = new ConfigStore({ Router: router, providers: [claudeProvider] })
  const out = selectModel(
    makeReq({
      model: 'claude-sonnet-4-5',
      tools: [{ type: 'web_search_20250305' }],
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }),
    1000,
    router,
    config
  )
  expect(out).toEqual({
    model: 'anthropic,claude-sub-search',
    scenarioType: 'webSearch',
    isSubagent: true,
    fallbacks: []
  })
})

test('selectModel: an unset subagent lane falls through even when the agent lane for that scenario is set', () => {
  // background is configured for the AGENT route only. A haiku SUBAGENT
  // request finds no subagent background route, so background does not win —
  // it falls through to the subagent default.
  const provider = { ...claudeProvider, models: ['claude-haiku-4-5'] }
  const router = {
    agent: { default: 'anthropic,claude-agent', background: 'anthropic,claude-agent-bg' },
    subagent: { default: 'anthropic,claude-sub' }
  }
  const config = new ConfigStore({ Router: router, providers: [provider] })
  const out = selectModel(
    makeReq({
      model: 'claude-haiku-4-5',
      system: [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x,y</RIALTO-SUBAGENT-MODEL>' }
      ]
    }),
    1000,
    router,
    config
  )
  expect(out).toEqual({ model: 'anthropic,claude-sub', scenarioType: 'default', isSubagent: true, fallbacks: [] })
})

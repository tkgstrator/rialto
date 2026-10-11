import { afterEach, beforeAll, beforeEach } from 'bun:test'
import pino from 'pino'
import dayjs from '../../src/lib/dayjs'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeRequest } from '../../src/llms/router'
import type { RouterRequest, RouterRequestBody } from '../../src/llms/router/types'
import { __setTierProfilesForTests } from '../../src/llms/tier-router/runtime'
import { clearModelExhaustion, clearProviderExhaustion } from '../../src/services/failover-state'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __resetModelHealthForTest, recordModelFailure } from '../../src/services/routing-scheduler/model-health'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'
import type { AccountQuotaView, TargetQuotaState } from '../../src/services/routing-scheduler/types'
import { mapWith, route } from './tier-fixture'

// Called inside each suite's describe so hooks and mutable state belong
// to that suite, not to whichever test file first imports this module.
export function createRouteRequestFixture() {
  // Every line the router logs, so the failure path can be asserted as
  // logged rather than silently swallowed.
  const logged: { lines: string[] } = { lines: [] }
  const log = pino(
    { level: 'info' },
    {
      write: (line: string) => {
        logged.lines.push(line)
      }
    }
  )

  const tokenizers = new TokenizerRegistry()
  beforeAll(async () => {
    await tokenizers.initialize()
  })

  // What Claude Code sends: a bare model name. It no longer picks a route.
  const CALLER_MODEL = 'claude-sonnet-4-5'
  const SONNET = 'claude-code,claude-sonnet-5'
  const CODEX = 'codex,gpt-5.5'
  const OPUS = 'claude-code,claude-opus-4-7'
  const LONG = 'google,gemini-3-pro'

  type Over = Parameters<typeof route>[3]
  const sonnetRoute = (over: Over = {}) => route('claude-code', 'sonnet', 'claude-sonnet-5', over)
  const codexRoute = (over: Over = {}) => route('codex', 'sonnet', 'gpt-5.5', over)
  const opusRoute = (over: Over = {}) => route('claude-code', 'opus', 'claude-opus-4-7', over)
  const longRoute = (over: Over = {}) => route('google', 'sonnet', 'gemini-3-pro', over)

  // The common shape: routes in the Default list of the agent lane only.
  const onDefault = (routes: ReturnType<typeof route>[], constraints: Parameters<typeof mapWith>[1] = {}) =>
    mapWith({ default: { agent: routes } }, constraints)

  // A map where every scenario and lane leads somewhere different, so the
  // target alone names the list the request walked.
  const everyList = () =>
    mapWith({
      default: { agent: [sonnetRoute()], subagent: [codexRoute()] },
      think: { agent: [opusRoute()], subagent: [route('codex', 'opus', 'gpt-5.5-pro')] },
      longContext: { agent: [longRoute()], subagent: [route('google', 'haiku', 'gemini-3-flash')] }
    })

  type RunOptions = {
    model?: string
    // Wire-shaped, as a client sends it: a web_search tool entry is not a
    // TokenizeTool, and the router has to cope with that anyway.
    body?: Record<string, unknown>
    path?: string
    profileKeyOverride?: string
    ActivePersona?: string | null
    tokenizers?: TokenizerRegistry
  }

  async function run(options: RunOptions = {}): Promise<RouterRequest> {
    // The router reads only the persona off the config now; which model a
    // route reaches is resolved by the map, not by the provider list.
    const config = new ConfigStore({
      Personas: [{ id: 'p1', name: 'brief', prompt: 'You are terse.' }],
      ActivePersona: options.ActivePersona === undefined ? null : options.ActivePersona
    })
    const req: RouterRequest = {
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        ...options.body,
        model: options.model === undefined ? CALLER_MODEL : options.model
      },
      log,
      inboundPath: options.path === undefined ? '/v1/messages' : options.path,
      ...(options.profileKeyOverride === undefined ? {} : { profileKeyOverride: options.profileKeyOverride })
    }
    await routeRequest(req, { config, tokenizers: options.tokenizers === undefined ? tokenizers : options.tokenizers })
    return req
  }

  const THINKING = { thinking: { type: 'enabled', budget_tokens: 4096 } }

  const subagentSystem = (tag = 'RIALTO-SUBAGENT-MODEL') => [
    { type: 'text', text: 'preamble' },
    { type: 'text', text: `<${tag}>anything</${tag}>` }
  ]

  const textOf = (system: RouterRequestBody['system'], index: number): string | undefined => {
    const text = Array.isArray(system) ? system[index]?.text : undefined
    return typeof text === 'string' ? text : undefined
  }

  // A prompt of some 1,500 tokens, and its size as the router counts it.
  // The windows below are set relative to that count rather than to one
  // tokenizer's exact output.
  const LONG_BODY = { messages: [{ role: 'user', content: 'lorem ipsum dolor sit amet '.repeat(300) }] }
  async function tokensOf(body: Record<string, unknown>): Promise<number> {
    const req = await run({ body, profileKeyOverride: 'never-saved' })
    if (req.tokenCount === undefined) throw new Error('the router did not count the prompt')
    return req.tokenCount
  }
  // A Default · agent window whose automatic threshold (70% of it) lands
  // just under, or just over, `tokens`. Either way the window itself holds
  // the prompt, so the context gate does not decide instead.
  const windowPuttingThresholdBelow = (tokens: number): number => Math.floor(tokens / 0.7) - 10
  const windowPuttingThresholdAbove = (tokens: number): number => Math.ceil(tokens / 0.7) + 10

  // One scheduler tick's worth of readings, keyed by target. Unnamed fields
  // read as "nothing known", which holds no route and orders none.
  type Reading = Partial<Omit<TargetQuotaState, 'target'>>
  const publishQuota = (targets: Record<string, Reading>, accounts: AccountQuotaView[] = []): void => {
    publishSnapshot({
      tickAt: dayjs().valueOf(),
      tickCount: 1,
      consecutiveFailures: 0,
      degraded: false,
      targets: new Map(
        Object.entries(targets).map(([target, reading]) => [
          target,
          { target, exhausted: false, remainingBudgetPct: null, projectedPct: null, resetAt: null, ...reading }
        ])
      ),
      accounts,
      soonestResetAt: null
    })
  }

  // The health gate needs `minHealthSamples` (5 by default) before a rate
  // means anything, so one failure is not enough to hold a route.
  const failRepeatedly = (target: string, times = 5): void => {
    for (const _ of Array.from({ length: times })) recordModelFailure(target)
  }

  const resetLiveState = (): void => {
    __resetSchedulerStateForTest()
    __resetModelHealthForTest()
    clearModelExhaustion('claude-code', 'claude-sonnet-5')
    clearModelExhaustion('claude-code', 'claude-opus-4-7')
    clearModelExhaustion('codex', 'gpt-5.5')
    clearModelExhaustion('google', 'gemini-3-pro')
    clearProviderExhaustion('claude-code')
    clearProviderExhaustion('codex')
    clearProviderExhaustion('google')
  }

  beforeEach(() => {
    __setSurfacesForTests({ 'anthropic-messages': 'routed' })
    __setTierProfilesForTests({})
    resetLiveState()
    logged.lines = []
  })

  afterEach(() => {
    __setSurfacesForTests({})
    __setTierProfilesForTests(null)
    resetLiveState()
  })

  return {
    logged,
    CALLER_MODEL,
    SONNET,
    CODEX,
    OPUS,
    LONG,
    sonnetRoute,
    codexRoute,
    opusRoute,
    longRoute,
    onDefault,
    everyList,
    run,
    THINKING,
    subagentSystem,
    textOf,
    LONG_BODY,
    tokensOf,
    windowPuttingThresholdBelow,
    windowPuttingThresholdAbove,
    publishQuota,
    failRepeatedly
  }
}

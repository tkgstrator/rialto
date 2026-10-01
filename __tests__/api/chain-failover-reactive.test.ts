import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import pino from 'pino'
import { attemptChainEntry, type ChainCtx } from '../../src/api/v1/chain-failover'
import type { ResolvedInvocation } from '../../src/api/v1/invocation'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import {
  clearModelExhaustion,
  clearProviderExhaustion,
  exhaustedUntil,
  isModelExhausted,
  isProviderExhausted
} from '../../src/services/failover-state'
import { __resetSchedulerStateForTest, publishSnapshot } from '../../src/services/routing-scheduler/state'
import type { AccountQuotaView } from '../../src/services/routing-scheduler/types'

const PROVIDER = {
  name: 'anthropic',
  auth_mode: 'subscription' as const,
  api_style: 'anthropic' as const,
  api_key: 'sk-ant',
  api_base_url: 'https://api.anthropic.com/v1/messages',
  models: ['claude-sonnet-5', 'claude-fable-5']
}
const log = pino({ level: 'silent' })
const resetAt = () => Date.now() + 60 * 60_000
const account = (weeklyUsed: number): AccountQuotaView => ({
  subAccountId: 'acct-1',
  providerName: 'anthropic',
  kind: 'claude',
  fiveHour: null,
  weekly: { used: weeklyUsed, limit: 100, resetAt: resetAt(), windowLengthMs: 7 * 24 * 60 * 60_000 },
  refreshedAt: Date.now(),
  stale: false
})
const publishAccounts = (accounts: AccountQuotaView[]): void => {
  publishSnapshot({
    tickAt: Date.now(),
    tickCount: 1,
    consecutiveFailures: 0,
    degraded: false,
    targets: new Map(),
    accounts,
    soonestResetAt: null
  })
}

async function run(model = 'claude-sonnet-5'): Promise<void> {
  const transformer = new AnthropicTransformer()
  const transformers = new TransformerRegistry(log)
  transformers.registerMany([transformer])
  const providers = new ProviderRegistry(transformers, log)
  providers.registerFromConfig([PROVIDER])
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const ctx: LlmsContext = {
    config: new ConfigStore({ Providers: [PROVIDER], providers: [PROVIDER] }),
    transformers,
    providers,
    tokenizers,
    log
  }
  const plan: RoutePlan = {
    routedBody: { model: `anthropic,${model}`, messages: [] },
    headers: {},
    transformersByName: new Map([['anthropic', transformer]]),
    defaultTransformer: transformer,
    route: 'passthrough',
    primaryModel: `anthropic,${model}`,
    isSubagent: false,
    fallbacks: [],
    path: '/v1/messages',
    search: '',
    accountSessionKey: 'reactive-no-sticky'
  }
  const app = new Hono()
  app.post('/*', async (c) => {
    const chain: ChainCtx = {
      c,
      ctx,
      plan,
      providers: [PROVIDER],
      sessionId: plan.accountSessionKey,
      attempt: async (_inv: ResolvedInvocation) => {
        // With no account stamp or session sticky there is no rotatable peer;
        // only the fresh quota reading can justify a provider-wide mark.
        throw new HTTPException(429, {
          message: `Error from provider(anthropic,${model}: 429): {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}`
        })
      },
      errorResponse: () => new Response('unexpected', { status: 500 })
    }
    const outcome = await attemptChainEntry(chain, `anthropic,${model}`)
    return new Response(outcome.kind, { status: outcome.kind === 'next' ? 200 : 500 })
  })
  const response = await app.fetch(new Request('http://local/v1/messages', { method: 'POST' }))
  expect(response.status).toBe(200)
}

afterEach(() => {
  clearProviderExhaustion('anthropic')
  clearModelExhaustion('anthropic', 'claude-sonnet-5')
  clearModelExhaustion('anthropic', 'claude-fable-5')
  __resetSchedulerStateForTest()
})

describe('reactive account-wide 429', () => {
  test('after no account remains to rotate, fresh spent weekly marks the provider', async () => {
    const spentAccount = account(100)
    publishAccounts([spentAccount])
    await run()
    expect(isProviderExhausted('anthropic')).toBe(true)
    expect(isModelExhausted('anthropic', 'claude-opus-4-7')).toBe(true)
    expect(exhaustedUntil('anthropic', 'claude-opus-4-7')).toBe(spentAccount.weekly?.resetAt)
  })

  test('a Fable-scoped weekly 429 does not park siblings without account-wide exhaustion', async () => {
    publishAccounts([account(40)])
    await run('claude-fable-5')
    expect(isProviderExhausted('anthropic')).toBe(false)
    expect(isModelExhausted('anthropic', 'claude-fable-5')).toBe(true)
    expect(isModelExhausted('anthropic', 'claude-sonnet-5')).toBe(false)
  })
})

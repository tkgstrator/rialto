/**
 * Which subscription account an attempt ran on.
 *
 * The OAuth transformer stamps the account on the attempt's own request
 * before it sends, and the chain walker reads that stamp: to know which
 * account a 429 came from (the one to park and rotate away from), and to
 * lift a stale exhaustion mark when an attempt succeeds. The session's
 * last-resolved account used to answer both, and a concurrent request of
 * the same session could overwrite it in between.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import pino from 'pino'
import { attemptAccountOf, attemptChainEntry, type ChainCtx } from '../../src/api/v1/chain-failover'
import { type ResolvedInvocation, resolveInvocationForModel } from '../../src/api/v1/invocation'
import type { RoutePlan } from '../../src/api/v1/route-plan'
import type { LlmsContext } from '../../src/llms'
import { ConfigStore } from '../../src/llms/registry/config'
import { ProviderRegistry } from '../../src/llms/registry/provider'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { TransformerRegistry } from '../../src/llms/registry/transformer'
import { AnthropicTransformer } from '../../src/llms/transformers/anthropic'
import { clearAccountExhaustion, isAccountExhausted, markAccountExhausted } from '../../src/services/failover-state'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'anthropic',
    auth_mode: 'api_key' as const,
    api_style: 'anthropic' as const,
    api_key: 'sk-ant',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5']
  }
]

const buildContext = async (): Promise<LlmsContext> => {
  const transformers = new TransformerRegistry(log)
  transformers.registerMany([new AnthropicTransformer()])
  const providers = new ProviderRegistry(transformers, log)
  providers.registerFromConfig(PROVIDERS)
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  return {
    config: new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS }),
    transformers,
    providers,
    tokenizers,
    log
  }
}

const planWith = (transformer: AnthropicTransformer): RoutePlan => ({
  routedBody: { model: 'anthropic,claude-sonnet-5', messages: [] },
  headers: {},
  transformersByName: new Map([['anthropic', transformer]]),
  defaultTransformer: transformer,
  scenarioType: 'default',
  primaryModel: 'anthropic,claude-sonnet-5',
  isSubagent: false,
  fallbacks: [],
  path: '/v1/messages',
  search: '',
  accountSessionKey: 'session-without-a-sticky'
})

const invocation = async (): Promise<ResolvedInvocation> => {
  const inv = resolveInvocationForModel(
    planWith(new AnthropicTransformer()),
    'anthropic,claude-sonnet-5',
    await buildContext()
  )
  if (inv === null) throw new Error('expected the target to resolve')
  return inv
}

afterEach(() => {
  clearAccountExhaustion('acct-served')
})

describe('attemptAccountOf', () => {
  test('the account stamped on the attempt wins', async () => {
    const inv = await invocation()
    inv.request.subAccountId = 'acct-served'
    expect(attemptAccountOf(inv, 'session-without-a-sticky')).toBe('acct-served')
  })

  test('an attempt the transformer never stamped falls back to the session', async () => {
    const inv = await invocation()
    // No sticky exists for this session key, so the fallback has nothing
    // to offer either.
    expect(attemptAccountOf(inv, 'session-without-a-sticky')).toBeNull()
  })
})

describe('a successful attempt', () => {
  const run = async (stamp: string | undefined): Promise<void> => {
    const ctx = await buildContext()
    const plan = planWith(new AnthropicTransformer())
    const app = new Hono()
    app.post('/*', async (c) => {
      const chain: ChainCtx = {
        c,
        ctx,
        plan,
        providers: [],
        sessionId: plan.accountSessionKey,
        attempt: async (inv) => {
          // What the OAuth transformer does on its way out.
          if (stamp !== undefined) inv.request.subAccountId = stamp
          return new Response('{}', { status: 200 })
        },
        errorResponse: () => new Response('unexpected', { status: 500 })
      }
      const outcome = await attemptChainEntry(chain, 'anthropic,claude-sonnet-5')
      return outcome.kind === 'done' ? outcome.response : new Response('next', { status: 502 })
    })
    const res = await app.fetch(new Request('http://local/v1/messages', { method: 'POST' }))
    expect(res.status).toBe(200)
  }

  test('lifts the exhaustion mark of the account that served it', async () => {
    markAccountExhausted('acct-served', Date.now() + 86_400_000)
    await run('acct-served')
    expect(isAccountExhausted('acct-served')).toBe(false)
  })

  test('without a stamp, no mark is touched on a guess', async () => {
    markAccountExhausted('acct-served', Date.now() + 86_400_000)
    await run(undefined)
    expect(isAccountExhausted('acct-served')).toBe(true)
  })
})

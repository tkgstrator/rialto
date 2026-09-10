import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../../src/db/client'
import { resolveQuotaAwareSelection } from '../../../src/llms/quota-router/runtime'
import { applyRouterPreferences } from '../../../src/services/router-preference-service'
import { __resetSchedulerStateForTest } from '../../../src/services/routing-scheduler/state'
import { HAS_DB, resetDbTables, teardownPrisma } from '../../db/helpers'

const describeOrSkip = HAS_DB ? describe : describe.skip

const emptyPair = () => ({ agent: [], subagent: [] })
const emptyChains = {
  default: emptyPair(),
  think: emptyPair(),
  longContext: emptyPair(),
  webSearch: emptyPair(),
  image: emptyPair()
}

describeOrSkip('resolveQuotaAwareSelection (DB + snapshot)', () => {
  beforeEach(async () => {
    await resetDbTables()
    __resetSchedulerStateForTest()
  })

  afterAll(async () => {
    await teardownPrisma()
  })

  test('empty per-scenario chain passes through regardless of exhaustedBehavior (not-configured shortcut)', async () => {
    // An empty preference chain means the operator hasn't set up this
    // lane. Treat that as "no opinion" and keep the caller's own model,
    // ignoring `exhaustedBehavior: '429'` — the 429 branch is meant for
    // real chains whose candidates are all currently gated, not for
    // the "nothing to route" case. Without this, a fresh install with a
    // '429' profile and no chain entries 429s every request.
    const out = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'default'
    })
    expect(out.selection.primary).toBeNull()
    expect(out.retryAfterSec).toBeNull()
  })

  test('passthrough constraint on an empty chain also passes through', async () => {
    // Same outcome via the constraints route — kept as a distinct
    // case so the empty-chain shortcut and the explicit
    // exhaustedBehavior:passthrough branch both stay covered.
    await applyRouterPreferences({
      entriesByScenario: emptyChains,
      constraints: { exhaustedBehavior: 'passthrough' }
    })
    const out = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'default'
    })
    expect(out.selection.primary).toBeNull()
    expect(out.retryAfterSec).toBeNull()
  })

  test('healthy primary in the request-matched scenario yields a target', async () => {
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: 'subscription',
        apiStyle: 'anthropic'
      }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-opus-5', enabled: true }
    })
    await applyRouterPreferences({
      entriesByScenario: {
        ...emptyChains,
        think: {
          agent: [{ priority: 1, target: 'claude-code,claude-opus-5', enabled: true }],
          subagent: []
        }
      },
      constraints: null
    })
    const out = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'think'
    })
    expect(out.selection.primary).toBe('claude-code,claude-opus-5')
    expect(out.retryAfterSec).toBeNull()
  })

  test('a caller-supplied profile is used instead of re-reading the row', async () => {
    // routeScenario has to read the profile BEFORE classification (the
    // classifier needs to know which lanes the chain can serve), so it
    // hands the loaded object back here rather than paying for a second
    // Prisma read. The DB is deliberately left empty for this case: if
    // the passed profile were ignored, the empty-chain shortcut would
    // return no primary.
    const out = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'think',
      profile: {
        entriesByScenario: {
          ...emptyChains,
          think: { agent: [{ priority: 1, target: 'claude-code,claude-opus-5', enabled: true }], subagent: [] }
        },
        constraints: null
      }
    })
    expect(out.selection.primary).toBe('claude-code,claude-opus-5')
  })

  test('a scenario without its own chain still passes through (empty-chain shortcut wins)', async () => {
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: 'subscription',
        apiStyle: 'anthropic'
      }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-opus-5', enabled: true }
    })
    await applyRouterPreferences({
      entriesByScenario: {
        ...emptyChains,
        think: {
          agent: [{ priority: 1, target: 'claude-code,claude-opus-5', enabled: true }],
          subagent: []
        }
      },
      constraints: null
    })
    // Same DB, but ask for default — the entry is only in `think`.
    const out = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'default'
    })
    expect(out.selection.primary).toBeNull()
    // Empty chain in this scenario → the caller's own model (no Retry-After).
    expect(out.retryAfterSec).toBeNull()
  })

  test('agent-only chain does not leak into subagent traffic (kind gates selector)', async () => {
    // The (scenario, kind) split means an entry configured only in the
    // agent lane is invisible to subagent calls. Without the kind gate
    // in loadPreferenceChain, subagent traffic would inherit whatever
    // the operator set up for agent.
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: 'subscription',
        apiStyle: 'anthropic'
      }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-opus-5', enabled: true }
    })
    await applyRouterPreferences({
      entriesByScenario: {
        ...emptyChains,
        default: {
          agent: [{ priority: 1, target: 'claude-code,claude-opus-5', enabled: true }],
          subagent: []
        }
      },
      constraints: null
    })
    const agentOut = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: false,
      scenario: 'default'
    })
    expect(agentOut.selection.primary).toBe('claude-code,claude-opus-5')
    const subagentOut = await resolveQuotaAwareSelection({
      requestedModel: 'claude-opus-5',
      isSubagent: true,
      scenario: 'default'
    })
    // Subagent lane is empty for this scenario → the caller's own model
    expect(subagentOut.selection.primary).toBeNull()
    expect(subagentOut.retryAfterSec).toBeNull()
  })

  test('subagent-only chain does not leak into agent traffic', async () => {
    // Symmetric guard: a subagent-lane entry must not resolve on an
    // agent call. Both kinds are truly independent.
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: {
        name: 'claude-code',
        apiBaseUrl: 'https://api.anthropic.com',
        authMode: 'subscription',
        apiStyle: 'anthropic'
      }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-haiku-4-5', enabled: true }
    })
    await applyRouterPreferences({
      entriesByScenario: {
        ...emptyChains,
        default: {
          agent: [],
          subagent: [{ priority: 1, target: 'claude-code,claude-haiku-4-5', enabled: true }]
        }
      },
      constraints: null
    })
    const agentOut = await resolveQuotaAwareSelection({
      requestedModel: 'claude-haiku-4-5',
      isSubagent: false,
      scenario: 'default'
    })
    expect(agentOut.selection.primary).toBeNull()
    expect(agentOut.retryAfterSec).toBeNull()
    const subagentOut = await resolveQuotaAwareSelection({
      requestedModel: 'claude-haiku-4-5',
      isSubagent: true,
      scenario: 'default'
    })
    expect(subagentOut.selection.primary).toBe('claude-code,claude-haiku-4-5')
  })
})

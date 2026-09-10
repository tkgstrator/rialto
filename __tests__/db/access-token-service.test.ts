/**
 * Access tokens.
 *
 * This is the credential store for the billable proxy, so the
 * properties worth pinning are the ones whose failure hands someone
 * else's traffic away: the plaintext must not be recoverable, a revoked
 * or expired token must stop working, and a token pinned to a surface
 * must not resolve as unscoped.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import {
  deleteAccessToken,
  getAccessToken,
  invalidateTokenCache,
  issueAccessToken,
  listAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
  rotateAccessToken,
  SPEND_WINDOW_DAYS,
  sumSpendByToken,
  sumTokensByToken,
  type TokenSpendGroup,
  updateAccessToken
} from '../../src/services/access-token-service'
import type { PriceEntry } from '../../src/services/cost-service'
import { HAS_DB, resetDbTables, teardownPrisma } from './helpers'

/**
 * Per-token spend arithmetic.
 *
 * Kept outside the DB block because the part that can quietly mislead is
 * arithmetic, not storage: an unpriced model must not read as a free
 * one, and a token that hit several models must total them rather than
 * report the last one.
 */
describe('sumSpendByToken', () => {
  const priced: PriceEntry = { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3 }
  const priceMap = new Map<string, PriceEntry>([['anthropic||claude-sonnet', priced]])

  const group = (over: Partial<TokenSpendGroup>): TokenSpendGroup => ({
    accessTokenId: 'tok1',
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over
  })

  test('sums every group belonging to one token', () => {
    const totals = sumSpendByToken([group({ inputTokens: 1_000_000 }), group({ outputTokens: 1_000_000 })], priceMap)
    // 1M input at $3 + 1M output at $15.
    expect(totals.get('tok1')).toBeCloseTo(18, 6)
  })

  test('token counts total across groups and keep tokens apart', () => {
    const totals = sumTokensByToken([
      group({ inputTokens: 10, outputTokens: 1 }),
      group({ inputTokens: 5, outputTokens: 2 }),
      group({ accessTokenId: 'tok2', inputTokens: 7, outputTokens: 3 }),
      // Traffic that presented no token belongs to no token.
      group({ accessTokenId: null, inputTokens: 999, outputTokens: 999 })
    ])
    expect(totals.get('tok1')).toEqual({ inputTokens: 15, outputTokens: 3 })
    expect(totals.get('tok2')).toEqual({ inputTokens: 7, outputTokens: 3 })
    expect(totals.size).toBe(2)
  })

  test('token counts survive a model with no price', () => {
    // `sumSpendByToken` drops this group; the counts must not follow it
    // out, or every subscription client would read as having sent nothing.
    const totals = sumTokensByToken([group({ model: 'unpriced-model', inputTokens: 42, outputTokens: 8 })])
    expect(sumSpendByToken([group({ model: 'unpriced-model', inputTokens: 42 })], priceMap).size).toBe(0)
    expect(totals.get('tok1')).toEqual({ inputTokens: 42, outputTokens: 8 })
  })

  test('cache tokens are not folded into the input count', () => {
    // They are priced on their own line, so adding them here would put a
    // number in the column that does not explain the cost beside it.
    const totals = sumTokensByToken([group({ inputTokens: 100, cacheReadTokens: 5_000, cacheWriteTokens: 900 })])
    expect(totals.get('tok1')?.inputTokens).toBe(100)
  })

  test('keeps two tokens apart', () => {
    const totals = sumSpendByToken(
      [group({ inputTokens: 1_000_000 }), group({ accessTokenId: 'tok2', inputTokens: 2_000_000 })],
      priceMap
    )
    expect(totals.get('tok1')).toBeCloseTo(3, 6)
    expect(totals.get('tok2')).toBeCloseTo(6, 6)
  })

  test('an unpriced model leaves the token absent rather than reporting $0', () => {
    // Subscription providers have no per-request price. Reporting zero
    // would say the traffic was free; absent renders as a dash, which
    // says the question was not answered.
    const totals = sumSpendByToken([group({ model: 'claude-opus-5', inputTokens: 1_000_000 })], priceMap)
    expect(totals.has('tok1')).toBe(false)
  })

  test('traffic with no token attached is not attributed to anyone', () => {
    const totals = sumSpendByToken([group({ accessTokenId: null, inputTokens: 1_000_000 })], priceMap)
    expect(totals.size).toBe(0)
  })
})

describe.skipIf(!HAS_DB)('access-token-service', () => {
  beforeEach(async () => {
    await resetDbTables()
    await getPrismaClient().accessToken.deleteMany({})
    invalidateTokenCache()
  })

  afterAll(teardownPrisma)

  test('listAccessTokens prices only the traffic inside the spend window', async () => {
    const { token } = await issueAccessToken({ name: 'ci' })
    const prisma = getPrismaClient()
    const provider = await prisma.provider.create({
      data: { name: 'anthropic', apiBaseUrl: 'https://api.anthropic.com', authMode: 'api_key', apiStyle: 'anthropic' }
    })
    await prisma.model.create({
      data: { providerId: provider.id, name: 'claude-sonnet', enabled: true, inputPer1M: 3, outputPer1M: 15 }
    })
    const session = await prisma.session.create({ data: { id: 'sess-spend' } })
    const log = (createdAt: Date, inputTokens: number) => ({
      sessionId: session.id,
      accessTokenId: token.id,
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens,
      outputTokens: 0,
      createdAt
    })
    const dayMs = 24 * 60 * 60 * 1000
    await prisma.requestLog.createMany({
      data: [
        log(new Date(Date.now() - dayMs), 1_000_000),
        // Older than the window: pricing it would make the column a
        // lifetime total, which the header does not claim.
        log(new Date(Date.now() - (SPEND_WINDOW_DAYS + 2) * dayMs), 5_000_000)
      ]
    })

    const [listed] = await listAccessTokens()
    expect(listed.costUsd).toBeCloseTo(3, 6)
  })

  test('the window token counts ride alongside the cost', async () => {
    const { token } = await issueAccessToken({ name: 'counted' })
    const prisma = getPrismaClient()
    const session = await prisma.session.create({ data: { id: 'sess-tokens' } })
    await prisma.requestLog.createMany({
      data: [
        {
          sessionId: session.id,
          accessTokenId: token.id,
          provider: 'anthropic',
          model: 'claude-sonnet',
          inputTokens: 1_000_000,
          outputTokens: 250_000,
          createdAt: dayjs().subtract(1, 'day').toDate()
        },
        // Outside the window, like the cost case above: the columns share
        // a span, so a row the cost ignores must not land in the counts.
        {
          sessionId: session.id,
          accessTokenId: token.id,
          provider: 'anthropic',
          model: 'claude-sonnet',
          inputTokens: 5_000_000,
          outputTokens: 5_000_000,
          createdAt: dayjs()
            .subtract(SPEND_WINDOW_DAYS + 2, 'day')
            .toDate()
        }
      ]
    })

    const [listed] = await listAccessTokens()
    expect(listed.inputTokens).toBe(1_000_000)
    expect(listed.outputTokens).toBe(250_000)
  })

  test('an unpriced model still reports its token counts', async () => {
    const { token } = await issueAccessToken({ name: 'subscription' })
    const prisma = getPrismaClient()
    const session = await prisma.session.create({ data: { id: 'sess-unpriced' } })
    await prisma.requestLog.create({
      data: {
        sessionId: session.id,
        accessTokenId: token.id,
        // No scraped price for this pair, which is every subscription
        // model. The cost is unknowable; the token counts are not, and
        // reporting them as absent would hide real traffic.
        provider: 'claude-code',
        model: 'claude-sonnet-5',
        inputTokens: 900,
        outputTokens: 100
      }
    })

    const [listed] = await listAccessTokens()
    expect(listed.costUsd).toBeNull()
    expect(listed.inputTokens).toBe(900)
    expect(listed.outputTokens).toBe(100)
  })

  test('a token with no priced traffic reports null, not zero', async () => {
    await issueAccessToken({ name: 'unused' })
    const [listed] = await listAccessTokens()
    expect(listed.costUsd).toBeNull()
    // Same distinction on the counts: no rows in the window is an absent
    // answer, and 0 would read as "this client sent nothing" about a
    // client whose logs simply aged out.
    expect(listed.inputTokens).toBeNull()
    expect(listed.outputTokens).toBeNull()
  })

  test('the plaintext is returned once and never stored', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'ci' })
    const stored = await getPrismaClient().accessToken.findUnique({ where: { id: token.id } })

    expect(plaintext.startsWith('rialto_')).toBe(true)
    // The row must not contain the secret in any form a reader could use.
    expect(JSON.stringify(stored)).not.toContain(plaintext)
    expect(stored?.tokenHash).not.toBe(plaintext)
  })

  test('the listed prefix identifies a token without being usable as one', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'ci' })
    expect(plaintext.startsWith(token.prefix)).toBe(true)
    expect(token.prefix.length).toBeLessThan(plaintext.length)
    expect(await resolveAccessToken(token.prefix)).toBeNull()
  })

  test('a freshly issued token resolves with its scope', async () => {
    const { plaintext } = await issueAccessToken({
      name: 'ci',
      surfaces: ['openai-chat'],
      profileKey: 'cost-first'
    })
    const resolved = await resolveAccessToken(plaintext)
    expect(resolved?.name).toBe('ci')
    expect(resolved?.surfaces).toEqual(['openai-chat'])
    expect(resolved?.profileKey).toBe('cost-first')
  })

  test('a token may be scoped to several surfaces at once', async () => {
    // The case a single-surface pin could not express: Codex speaks both
    // /v1/responses and /v1/chat/completions, so pinning it to either
    // meant the other 401'd and the only way out was no scope at all.
    const { plaintext } = await issueAccessToken({
      name: 'codex',
      surfaces: ['openai-responses', 'openai-chat']
    })
    const resolved = await resolveAccessToken(plaintext)
    expect(resolved?.surfaces).toEqual(['openai-responses', 'openai-chat'])
  })

  test('an unscoped token resolves with an empty scope rather than defaults', async () => {
    const { plaintext } = await issueAccessToken({ name: 'anything' })
    const resolved = await resolveAccessToken(plaintext)
    expect(resolved?.surfaces).toEqual([])
    expect(resolved?.profileKey).toBeNull()
  })

  test('a revoked token stops resolving but stays listed', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'leaked' })
    await revokeAccessToken(token.id)

    expect(await resolveAccessToken(plaintext)).toBeNull()
    // Revoke keeps the row so past requests still say whose they were.
    const listed = await listAccessTokens()
    expect(listed).toHaveLength(1)
    expect(listed[0].revokedAt).not.toBeNull()
  })

  test('an expired token stops resolving', async () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const { plaintext } = await issueAccessToken({ name: 'old', expiresAt: past })
    expect(await resolveAccessToken(plaintext)).toBeNull()
  })

  test('a token expiring in the future still resolves', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const { plaintext } = await issueAccessToken({ name: 'valid', expiresAt: future })
    expect(await resolveAccessToken(plaintext)).not.toBeNull()
  })

  test('an unknown value never resolves', async () => {
    expect(await resolveAccessToken('rialto_deadbeef')).toBeNull()
    expect(await resolveAccessToken('')).toBeNull()
  })

  test('two tokens are distinct credentials', async () => {
    const a = await issueAccessToken({ name: 'a' })
    const b = await issueAccessToken({ name: 'b' })
    expect(a.plaintext).not.toBe(b.plaintext)
    expect((await resolveAccessToken(a.plaintext))?.name).toBe('a')
    expect((await resolveAccessToken(b.plaintext))?.name).toBe('b')
  })

  test('revocation takes effect immediately despite the hot-path cache', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'ci' })
    // Prime the cache the way a real request would.
    expect(await resolveAccessToken(plaintext)).not.toBeNull()
    await revokeAccessToken(token.id)
    expect(await resolveAccessToken(plaintext)).toBeNull()
  })

  test('a leftover APIKEY value is not an access token', async () => {
    // /v1/* is a Bypass path at the edge, so whatever resolves here is
    // the only thing in front of the operator's credits. An install that
    // still has the retired envelope key set must not gain a second,
    // unrevocable way in.
    process.env.APIKEY = 'leftover-value-that-must-not-work'
    expect(await resolveAccessToken('leftover-value-that-must-not-work')).toBeNull()
  })

  test('deletion also takes effect immediately', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'ci' })
    expect(await resolveAccessToken(plaintext)).not.toBeNull()
    expect(await deleteAccessToken(token.id)).toBe(true)
    expect(await resolveAccessToken(plaintext)).toBeNull()
    expect(await listAccessTokens()).toHaveLength(0)
  })

  test('getAccessToken reads one row, and null for an id that is not one', async () => {
    const { token } = await issueAccessToken({ name: 'ci' })
    expect((await getAccessToken(token.id))?.name).toBe('ci')
    expect(await getAccessToken('no-such-id')).toBeNull()
  })

  test('rotation swaps the secret and keeps everything else about the row', async () => {
    const { token, plaintext } = await issueAccessToken({
      name: 'ci',
      surfaces: ['anthropic-messages'],
      profileKey: 'cost-first'
    })
    // A request against the original, so the row carries history worth
    // preserving across the rotation.
    await getPrismaClient().accessToken.update({
      where: { id: token.id },
      data: { requestCount: 41, lastUsedAt: dayjs('2026-01-02T03:04:05Z').toDate() }
    })
    invalidateTokenCache()

    const result = await rotateAccessToken(token.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Same row: the id is what every RequestLog points at, so losing it
    // would take the attribution with it.
    expect(result.issued.token.id).toBe(token.id)
    expect(result.issued.token.name).toBe('ci')
    expect(result.issued.token.surfaces).toEqual(['anthropic-messages'])
    expect(result.issued.token.profileKey).toBe('cost-first')
    expect(result.issued.token.requestCount).toBe(41)
    expect(result.issued.token.createdAt).toBe(token.createdAt)
    expect(result.issued.token.rotatedAt).not.toBeNull()

    // New secret, and only one row.
    expect(result.issued.plaintext).not.toBe(plaintext)
    expect(result.issued.token.prefix).not.toBe(token.prefix)
    expect(await listAccessTokens()).toHaveLength(1)
  })

  test('the previous secret stops working the moment it is rotated', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'ci' })
    // Prime the hot-path cache the way a real request would, so this
    // also covers the invalidation and not just the stored hash.
    expect(await resolveAccessToken(plaintext)).not.toBeNull()

    const result = await rotateAccessToken(token.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(await resolveAccessToken(plaintext)).toBeNull()
    expect((await resolveAccessToken(result.issued.plaintext))?.id).toBe(token.id)
  })

  test('scope and profile can be changed without touching the secret', async () => {
    const { token, plaintext } = await issueAccessToken({ name: 'codex', surfaces: ['openai-responses'] })
    expect(await resolveAccessToken(plaintext)).not.toBeNull()

    const updated = await updateAccessToken(token.id, {
      surfaces: ['openai-responses', 'openai-chat'],
      profileKey: 'cost-first'
    })
    expect(updated?.surfaces).toEqual(['openai-responses', 'openai-chat'])
    expect(updated?.profileKey).toBe('cost-first')
    expect(updated?.prefix).toBe(token.prefix)

    // The client keeps the credential it already has — widening the
    // scope is not a reason to reissue — and the resolver sees the new
    // scope immediately rather than after the cache TTL.
    const resolved = await resolveAccessToken(plaintext)
    expect(resolved?.surfaces).toEqual(['openai-responses', 'openai-chat'])
    expect(resolved?.profileKey).toBe('cost-first')
  })

  test('an omitted field is left alone, and a null profile clears it', async () => {
    const { token } = await issueAccessToken({
      name: 'ci',
      surfaces: ['openai-chat'],
      profileKey: 'cost-first'
    })

    // Scope only: the profile must survive.
    const scopeOnly = await updateAccessToken(token.id, { surfaces: [] })
    expect(scopeOnly?.surfaces).toEqual([])
    expect(scopeOnly?.profileKey).toBe('cost-first')

    // Null is a value here, not "unchanged" — it puts the token back on
    // the endpoint's own routing.
    const cleared = await updateAccessToken(token.id, { profileKey: null })
    expect(cleared?.profileKey).toBeNull()

    expect(await updateAccessToken('no-such-id', { surfaces: [] })).toBeNull()
  })

  test('a revoked or expired token is refused rather than handed a dead secret', async () => {
    const revoked = await issueAccessToken({ name: 'revoked' })
    await revokeAccessToken(revoked.token.id)
    expect(await rotateAccessToken(revoked.token.id)).toEqual({ ok: false, reason: 'revoked' })

    const expired = await issueAccessToken({
      name: 'expired',
      expiresAt: dayjs().subtract(1, 'minute').toISOString()
    })
    expect(await rotateAccessToken(expired.token.id)).toEqual({ ok: false, reason: 'expired' })

    expect(await rotateAccessToken('no-such-id')).toEqual({ ok: false, reason: 'not-found' })
  })
})

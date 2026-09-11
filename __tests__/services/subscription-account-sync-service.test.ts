/**
 * Tests for subscription-account-sync-service — the write path for
 * OAuth credentials and the read path for the proxy hot path.
 *
 * Two halves:
 *
 *  1. Crypto (no DB, no network): decryptString edge cases and a
 *     full encrypt→store→decrypt roundtrip via the DB helpers.
 *
 *  2. DB (require HAS_DB): the write path — recordDiscoveredAccount fed by
 *     buildCodexDiscoveredAccount / claudeAccountFromProfile (with a mocked
 *     fetchClaudeProfile) — getUsableSubAccountAuth, and
 *     updateSubAccountAccessToken.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { fetchClaudeProfile } from '../../src/services/claude-profile-service'
import {
  buildCodexDiscoveredAccount,
  claudeAccountFromProfile,
  decryptString,
  getUsableSubAccountAuth,
  recordDiscoveredAccount,
  updateSubAccountAccessToken
} from '../../src/services/subscription-account-sync-service'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

// The write path without the vendor check subscription-connect-service puts
// in front of it: these tests are about what gets stored, and connecting
// would first ask the vendor to accept the tokens. Named after the two
// functions that used to be exported for exactly this, so the cases below
// read as they always did.
const recordCodexOAuthAccount = async (
  tokens: Parameters<typeof buildCodexDiscoveredAccount>[0]
): Promise<string[]> => {
  const account = buildCodexDiscoveredAccount(tokens)
  return account === null ? [] : recordDiscoveredAccount('codex', account)
}

const recordClaudeOAuthAccount = async (tokens: Parameters<typeof claudeAccountFromProfile>[0]): Promise<string[]> => {
  const profile = await fetchClaudeProfile(tokens.accessToken)
  const account = profile === null ? null : claudeAccountFromProfile(tokens, profile)
  return account === null ? [] : recordDiscoveredAccount('claude', account)
}

// ---------------------------------------------------------------------------
// Mock fetchClaudeProfile before any import resolves against the real service.
// ---------------------------------------------------------------------------
const fetchClaudeProfileMock = mock(async (_token: string) => ({
  account: {
    uuid: 'user-uuid-123',
    full_name: 'Test User',
    display_name: 'tuser',
    email: 'test@example.com'
  },
  organization: {
    organization_type: 'personal',
    rate_limit_tier: 'standard'
  }
}))

mock.module('../../src/services/claude-profile-service', () => ({
  fetchClaudeProfile: fetchClaudeProfileMock
}))

// ---------------------------------------------------------------------------
// Helpers shared by both halves
// ---------------------------------------------------------------------------

// 32-byte hex key (64 hex chars) — accepted as-is by encryptionKey().
const TEST_KEY_HEX = 'ab'.repeat(32)

const setTestKey = () => {
  process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
}

const clearTestKey = () => {
  delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
}

// Build a valid AES-256-GCM ciphertext in the iv.tag.body format that
// encryptString produces, so we can test decryptString without relying
// on the private encryptString export.
const encryptForTest = (plain: string, keyHex: string): string => {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

// Minimal valid Codex id_token (header.payload.signature). The payload
// carries just the claims that buildCodexDiscoveredAccount reads.
const makeCodexIdToken = (overrides: Record<string, unknown> = {}): string => {
  const payload = {
    sub: 'user-sub-abc',
    name: 'Codex User',
    email: 'codex@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc-xyz',
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: new Date(Date.now() + 30 * 24 * 3600_000).toISOString()
    },
    ...overrides
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.sig`
}

// ---------------------------------------------------------------------------
// 1. Crypto unit tests (no DB)
// ---------------------------------------------------------------------------

describe('decryptString', () => {
  test('returns null for null input', () => {
    setTestKey()
    expect(decryptString(null, Buffer.from(TEST_KEY_HEX, 'hex'))).toBeNull()
    clearTestKey()
  })

  test('returns null for string with wrong part count', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    expect(decryptString('only.two', key)).toBeNull()
    expect(decryptString('one', key)).toBeNull()
    expect(decryptString('a.b.c.d', key)).toBeNull()
  })

  test('returns null when auth tag is wrong (different key)', () => {
    setTestKey()
    const enc = encryptForTest('secret', TEST_KEY_HEX)
    const wrongKey = Buffer.from('cd'.repeat(32), 'hex')
    expect(decryptString(enc, wrongKey)).toBeNull()
    clearTestKey()
  })

  test('roundtrip: encrypt then decrypt returns original plaintext', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const plain = 'sk-ant-super-secret-token'
    const enc = encryptForTest(plain, TEST_KEY_HEX)
    expect(decryptString(enc, key)).toBe(plain)
  })

  test('roundtrip is stable across multiple encryptions (different IVs)', () => {
    const key = Buffer.from(TEST_KEY_HEX, 'hex')
    const plain = 'token-value'
    // Two encryptions produce different ciphertexts (random IV) but both decrypt.
    const enc1 = encryptForTest(plain, TEST_KEY_HEX)
    const enc2 = encryptForTest(plain, TEST_KEY_HEX)
    expect(enc1).not.toBe(enc2)
    expect(decryptString(enc1, key)).toBe(plain)
    expect(decryptString(enc2, key)).toBe(plain)
  })
})

// ---------------------------------------------------------------------------
// 2. DB-backed tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)('subscription-account-sync-service (DB)', () => {
  const prisma = () => {
    const { getPrismaClient } = require('../../src/db/client')
    return getPrismaClient()
  }

  beforeEach(async () => {
    setTestKey()
    fetchClaudeProfileMock.mockClear()
    await resetDbTables()
  })

  afterAll(async () => {
    clearTestKey()
    await teardownPrisma()
  })

  const createSubProvider = async (kind: 'claude' | 'codex', enabled = true) => {
    const { AuthMode } = await import('../../src/generated/prisma/client')
    const db = prisma()
    return db.provider.create({
      data: {
        name: kind === 'claude' ? 'claude-code-oauth' : 'codex-oauth',
        apiBaseUrl: kind === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
        authMode: AuthMode.subscription,
        enabled
      }
    })
  }

  // -------------------------------------------------------------------------
  // recordCodexOAuthAccount
  // -------------------------------------------------------------------------

  describe('recordCodexOAuthAccount', () => {
    test('upserts SubAccount row and sets provider active account', async () => {
      await createSubProvider('codex')
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'codex-at',
        refreshToken: 'codex-rt',
        idToken: makeCodexIdToken()
      })

      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(1)
      expect(accounts[0].sourcePath).toBe('oauth:codex:acc-xyz')
      expect(accounts[0].accountId).toBe('acc-xyz')
      expect(accounts[0].userId).toBe('user-sub-abc')
      // Tokens must be encrypted (not plaintext).
      expect(accounts[0].accessTokenEnc).not.toBeNull()
      expect(accounts[0].accessTokenEnc).not.toBe('codex-at')

      // The account is a candidate the moment it is written — nothing
      // has to promote it into a designated slot.
      expect(accounts[0].enabled).toBe(true)
    })

    test('decrypted tokens match originals', async () => {
      await createSubProvider('codex')
      const key = Buffer.from(TEST_KEY_HEX, 'hex')
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'at-value',
        refreshToken: 'rt-value',
        idToken: makeCodexIdToken()
      })

      const row = await db.subAccount.findFirst()
      expect(row).not.toBeNull()
      expect(decryptString(row!.accessTokenEnc, key)).toBe('at-value')
      expect(decryptString(row!.refreshTokenEnc, key)).toBe('rt-value')
    })

    test('skips upsert when idToken cannot be decoded', async () => {
      await createSubProvider('codex')
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: 'not.a.jwt'
      })

      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(0)
    })

    test('skips upsert when no matching subscription provider exists', async () => {
      // No provider created — should silently skip.
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: makeCodexIdToken()
      })

      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(0)
    })

    test('second call updates the existing row (idempotent upsert)', async () => {
      await createSubProvider('codex')
      const key = Buffer.from(TEST_KEY_HEX, 'hex')
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'at-v1',
        refreshToken: 'rt-v1',
        idToken: makeCodexIdToken()
      })
      await recordCodexOAuthAccount({
        accessToken: 'at-v2',
        refreshToken: 'rt-v2',
        idToken: makeCodexIdToken()
      })

      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(1)
      expect(decryptString(accounts[0].accessTokenEnc, key)).toBe('at-v2')
    })
  })

  // -------------------------------------------------------------------------
  // Provider.enabled — the flag Routing filters on
  // -------------------------------------------------------------------------

  describe('enabling the provider on its first account', () => {
    // The add-provider wizard creates the row switched off, because the
    // OAuth callback needs it to exist before a credential arrives. Its
    // final Continue used to be the only thing that ever switched it back
    // on, and OAuth opens in a second tab — so an operator who did not
    // return to that step was left signed in but unroutable.
    test('a provider created switched off is on once an account lands', async () => {
      const provider = await createSubProvider('codex', false)
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'codex-at',
        refreshToken: 'codex-rt',
        idToken: makeCodexIdToken()
      })

      const after = await db.provider.findUnique({ where: { id: provider.id } })
      expect(after?.enabled).toBe(true)
    })

    test('a deliberate off on a provider that already has an account survives re-auth', async () => {
      // Once set up, the switch belongs to the operator: refreshing an
      // expired credential must not undo their decision to park it.
      const provider = await createSubProvider('codex')
      const db = prisma()

      await recordCodexOAuthAccount({
        accessToken: 'at-v1',
        refreshToken: 'rt-v1',
        idToken: makeCodexIdToken()
      })
      await db.provider.update({ where: { id: provider.id }, data: { enabled: false } })

      await recordCodexOAuthAccount({
        accessToken: 'at-v2',
        refreshToken: 'rt-v2',
        idToken: makeCodexIdToken()
      })

      const after = await db.provider.findUnique({ where: { id: provider.id } })
      expect(after?.enabled).toBe(false)
    })

    test('the claude path enables too', async () => {
      const provider = await createSubProvider('claude', false)
      const db = prisma()

      await recordClaudeOAuthAccount({
        accessToken: 'claude-at',
        refreshToken: 'claude-rt',
        expiresAt: Date.now() + 3600_000,
        scopes: ['read']
      })

      const after = await db.provider.findUnique({ where: { id: provider.id } })
      expect(after?.enabled).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // recordClaudeOAuthAccount
  // -------------------------------------------------------------------------

  describe('recordClaudeOAuthAccount', () => {
    test('upserts SubAccount row using profile data', async () => {
      await createSubProvider('claude')
      const db = prisma()

      await recordClaudeOAuthAccount({
        accessToken: 'claude-at',
        refreshToken: 'claude-rt',
        expiresAt: Date.now() + 3600_000,
        scopes: ['read', 'write']
      })

      expect(fetchClaudeProfileMock).toHaveBeenCalledTimes(1)
      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(1)
      expect(accounts[0].sourcePath).toBe('oauth:claude:user-uuid-123')
      expect(accounts[0].userId).toBe('user-uuid-123')
      expect(accounts[0].userEmail).toBe('test@example.com')
    })

    test('skips upsert when profile returns no uuid', async () => {
      fetchClaudeProfileMock.mockImplementationOnce(async () => ({
        account: { uuid: null, full_name: null, display_name: null, email: null },
        organization: null
      }))
      await createSubProvider('claude')
      const db = prisma()

      await recordClaudeOAuthAccount({
        accessToken: 'claude-at',
        refreshToken: 'claude-rt',
        expiresAt: null,
        scopes: []
      })

      const accounts = await db.subAccount.findMany()
      expect(accounts).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // getUsableSubAccountAuth
  // -------------------------------------------------------------------------

  describe('getUsableSubAccountAuth', () => {
    test('returns null when no subscription provider exists', async () => {
      const result = await getUsableSubAccountAuth('nonexistent')
      expect(result).toBeNull()
    })

    test('returns null when the provider has no account at all', async () => {
      await createSubProvider('codex')
      const result = await getUsableSubAccountAuth('codex-oauth')
      expect(result).toBeNull()
    })

    test('skips a disabled account and takes an enabled peer', async () => {
      const provider = await createSubProvider('codex')
      const db = prisma()
      await recordCodexOAuthAccount({
        accessToken: 'off-at',
        refreshToken: 'off-rt',
        idToken: makeCodexIdToken()
      })
      // Disable the only synced account and add a second, enabled one.
      // The reader must answer with the account that can actually serve,
      // not with whichever row a binding used to point at.
      await db.subAccount.updateMany({ where: { providerId: provider.id }, data: { enabled: false } })
      await db.subAccount.create({
        data: {
          providerId: provider.id,
          sourcePath: 'oauth:codex:peer',
          label: 'codex:peer',
          enabled: true,
          accessTokenEnc: encryptForTest('peer-at', TEST_KEY_HEX),
          refreshTokenEnc: encryptForTest('peer-rt', TEST_KEY_HEX)
        }
      })

      const auth = await getUsableSubAccountAuth('codex-oauth')
      expect(auth?.accessToken).toBe('peer-at')
    })

    test('returns decrypted tokens for a usable account', async () => {
      await createSubProvider('codex')
      await recordCodexOAuthAccount({
        accessToken: 'live-at',
        refreshToken: 'live-rt',
        idToken: makeCodexIdToken()
      })

      const auth = await getUsableSubAccountAuth('codex-oauth')
      expect(auth).not.toBeNull()
      expect(auth!.accessToken).toBe('live-at')
      expect(auth!.refreshToken).toBe('live-rt')
      expect(auth!.accountId).toBe('acc-xyz')
      expect(auth!.subAccountId).toBeString()
    })
  })

  // -------------------------------------------------------------------------
  // updateSubAccountAccessToken
  // -------------------------------------------------------------------------

  describe('updateSubAccountAccessToken', () => {
    test('updates access token and re-encrypts', async () => {
      await createSubProvider('codex')
      await recordCodexOAuthAccount({
        accessToken: 'old-at',
        refreshToken: 'old-rt',
        idToken: makeCodexIdToken()
      })

      const before = await getUsableSubAccountAuth('codex-oauth')
      expect(before!.accessToken).toBe('old-at')

      await updateSubAccountAccessToken(before!.subAccountId, {
        accessToken: 'new-at',
        refreshToken: 'new-rt',
        expiresAt: new Date(Date.now() + 3600_000)
      })

      const after = await getUsableSubAccountAuth('codex-oauth')
      expect(after!.accessToken).toBe('new-at')
      expect(after!.refreshToken).toBe('new-rt')
    })

    test('does not update refreshToken when omitted', async () => {
      await createSubProvider('codex')
      await recordCodexOAuthAccount({
        accessToken: 'old-at',
        refreshToken: 'keep-rt',
        idToken: makeCodexIdToken()
      })

      const before = await getUsableSubAccountAuth('codex-oauth')
      await updateSubAccountAccessToken(before!.subAccountId, { accessToken: 'new-at' })

      const after = await getUsableSubAccountAuth('codex-oauth')
      expect(after!.accessToken).toBe('new-at')
      expect(after!.refreshToken).toBe('keep-rt')
    })
  })
})

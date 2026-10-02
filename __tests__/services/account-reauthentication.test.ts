import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPrismaClient } from '../../src/db/client'
import { AuthMode } from '../../src/generated/prisma/client'
import { decryptString } from '../../src/services/subscription-account-sync/crypto'
import {
  buildCodexDiscoveredAccount,
  claudeAccountFromProfile
} from '../../src/services/subscription-account-sync/discovery'
import { recordDiscoveredAccount } from '../../src/services/subscription-account-sync/persist'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const key = 'ab'.repeat(32)
const previousKey = process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
function account(accountId: string, userId?: string) {
  const discovered = buildCodexDiscoveredAccount({
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    accountId,
    idToken:
      userId === undefined
        ? null
        : `header.${Buffer.from(JSON.stringify({ sub: userId, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.sig`
  })
  if (discovered === null) throw new Error('Invalid fixture')
  return discovered
}

const target = () => getPrismaClient().subAccount.findUniqueOrThrow({ where: { id: 'target' } })

describe.skipIf(!HAS_DB)('targeted account reauthentication (DB)', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = key
    await resetDbTables()
    const prisma = getPrismaClient()
    await prisma.provider.create({
      data: {
        id: 'provider',
        name: 'codex',
        enabled: false,
        authMode: AuthMode.subscription,
        apiBaseUrl: 'https://chatgpt.com/backend-api'
      }
    })
    await prisma.subAccount.create({
      data: {
        id: 'target',
        providerId: 'provider',
        label: 'My account',
        sourcePath: 'legacy-path',
        accountId: 'account',
        enabled: false
      }
    })
  })
  afterAll(async () => {
    if (previousKey === undefined) delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    else process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = previousKey
    await teardownPrisma()
  })

  test('updates the same row despite newly available user identity and preserves settings', async () => {
    const prisma = getPrismaClient()
    expect(await recordDiscoveredAccount('codex', account('account', 'user'), prisma, 'target')).toEqual(['target'])
    expect(await prisma.subAccount.count()).toBe(1)
    const row = await target()
    expect(row.label).toBe('My account')
    expect(row.enabled).toBe(false)
    expect(row.sourcePath).toBe('legacy-path')
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: 'provider' } })).enabled).toBe(false)
    expect(decryptString(row.accessTokenEnc, Buffer.from(key, 'hex'))).toBe('fresh-access')
  })

  test('a different account cannot overwrite the target or create another account', async () => {
    const prisma = getPrismaClient()
    await expect(recordDiscoveredAccount('codex', account('different'), prisma, 'target')).rejects.toThrow()
    expect(await prisma.subAccount.count()).toBe(1)
    expect((await target()).accessTokenEnc).toBeNull()
  })

  test('a deleted target cannot silently become a new account', async () => {
    const prisma = getPrismaClient()
    await expect(recordDiscoveredAccount('codex', account('account'), prisma, 'deleted')).rejects.toThrow()
    expect(await prisma.subAccount.count()).toBe(1)
    expect((await target()).accessTokenEnc).toBeNull()
  })

  test('an account for a different vendor cannot be reauthenticated', async () => {
    await expect(recordDiscoveredAccount('claude', account('account'), getPrismaClient(), 'target')).rejects.toThrow()
    expect((await target()).accessTokenEnc).toBeNull()
  })

  test('another user in the same Codex workspace cannot replace the selected user', async () => {
    const prisma = getPrismaClient()
    await prisma.subAccount.update({ where: { id: 'target' }, data: { userId: 'selected-user' } })
    await expect(recordDiscoveredAccount('codex', account('account', 'other-user'), prisma, 'target')).rejects.toThrow()
    expect((await target()).accessTokenEnc).toBeNull()
  })

  test('Claude identity must match before any credentials are stored', async () => {
    const prisma = getPrismaClient()
    await prisma.provider.update({ where: { id: 'provider' }, data: { apiBaseUrl: 'https://api.anthropic.com' } })
    await prisma.subAccount.update({ where: { id: 'target' }, data: { userId: 'selected-user', accountId: null } })
    const tokens = { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: null, scopes: [] }
    const wrong = claudeAccountFromProfile(tokens, { account: { uuid: 'other-user' } })
    const right = claudeAccountFromProfile(tokens, { account: { uuid: 'selected-user' } })
    if (wrong === null || right === null) throw new Error('Invalid fixture')
    await expect(recordDiscoveredAccount('claude', wrong, prisma, 'target')).rejects.toThrow()
    expect((await target()).accessTokenEnc).toBeNull()
    expect(await recordDiscoveredAccount('claude', right, prisma, 'target')).toEqual(['target'])
    expect((await target()).label).toBe('My account')
    expect(await prisma.subAccount.count()).toBe(1)
  })
})

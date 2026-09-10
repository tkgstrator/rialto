/**
 * POST /api/oauth/export-credentials — symmetric round-trip of
 * `import-credentials`. Verifies:
 *
 *   - Rejects unknown provider strings (400)
 *   - 404 when the vendor kind has no subscription provider registered
 *   - 404 when the provider has no active SubAccount
 *   - Claude payload matches ~/.claude/.credentials.json wire shape and
 *     ClaudeCredentialsFileSchema round-trips it back
 *   - Codex payload matches ~/.codex/auth.json wire shape and
 *     CodexCredentialsFileSchema round-trips it back
 *   - `Content-Disposition: attachment; filename=...` fires so the
 *     browser download prompt triggers
 *   - Missing codex id_token surfaces as 409 (not a corrupt export)
 *
 * DB-gated: skipped when TEST_DATABASE_URL isn't wired up in the env.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { oauthRoute } from '../../src/api/oauth/route'
import { ClaudeCredentialsFileSchema, CodexCredentialsFileSchema } from '../../src/schemas/wire/oauth'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

const TEST_KEY_HEX = 'ab'.repeat(32)

const setTestKey = () => {
  process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = TEST_KEY_HEX
}
const clearTestKey = () => {
  delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
}

// Match subscription-account-sync-service.test.ts's helper — encrypt a
// value with the same iv.tag.body format encryptString() produces, so
// we can seed SubAccount rows directly without the OAuth flow.
const encryptForTest = (plain: string, keyHex: string): string => {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

const post = (body: unknown): Promise<Response> =>
  oauthRoute.fetch(
    new Request('http://local/api/oauth/export-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

describe('POST /api/oauth/export-credentials — provider gate (no DB required)', () => {
  test('unknown provider → 400', async () => {
    const res = await post({ provider: 'bogus' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('bogus')
  })

  test('missing provider field → 400 (invalid input)', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
  })

  test('malformed JSON body → 400 (invalid input)', async () => {
    const res = await oauthRoute.fetch(
      new Request('http://local/api/oauth/export-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json'
      })
    )
    expect(res.status).toBe(400)
  })
})

describe.skipIf(!HAS_DB)('POST /api/oauth/export-credentials (DB)', () => {
  const prisma = () => {
    const { getPrismaClient } = require('../../src/db/client')
    return getPrismaClient()
  }

  beforeEach(async () => {
    setTestKey()
    await resetDbTables()
  })

  afterAll(async () => {
    clearTestKey()
    await teardownPrisma()
  })

  // Seed one subscription provider of the requested kind, backed by a
  // ready-to-decrypt SubAccount. `enabled` toggles whether that row is a
  // candidate at all — the export walks the provider's enabled accounts,
  // no row being designated any more.
  const seedProviderWithAccount = async (opts: {
    kind: 'claude' | 'codex'
    tokens: { accessToken: string; refreshToken: string; idToken?: string }
    scopes?: string[]
    expiresAt?: Date | null
    enabled?: boolean
  }): Promise<{ providerId: string; subAccountId: string }> => {
    const { AuthMode } = await import('../../src/generated/prisma/client')
    const db = prisma()
    const provider = await db.provider.create({
      data: {
        name: opts.kind === 'claude' ? 'claude-code' : 'codex',
        apiBaseUrl:
          opts.kind === 'claude' ? 'https://api.anthropic.com/v1/messages' : 'https://chatgpt.com/backend-api/codex',
        authMode: AuthMode.subscription
      }
    })
    const subAccount = await db.subAccount.create({
      data: {
        providerId: provider.id,
        sourcePath: `oauth:${opts.kind}:test`,
        label: 'test',
        enabled: opts.enabled !== false,
        accessTokenEnc: encryptForTest(opts.tokens.accessToken, TEST_KEY_HEX),
        refreshTokenEnc: encryptForTest(opts.tokens.refreshToken, TEST_KEY_HEX),
        idTokenEnc: opts.tokens.idToken ? encryptForTest(opts.tokens.idToken, TEST_KEY_HEX) : null,
        scopes: opts.scopes ?? null,
        expiresAt: opts.expiresAt ?? null
      }
    })
    return { providerId: provider.id, subAccountId: subAccount.id }
  }

  test('404 when no subscription provider is registered for the kind', async () => {
    const res = await post({ provider: 'claude' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.error).toContain('claude')
  })

  test('404 when the provider only has disabled accounts', async () => {
    await seedProviderWithAccount({
      kind: 'claude',
      tokens: { accessToken: 'sk-ant-live', refreshToken: 'r' },
      enabled: false
    })
    const res = await post({ provider: 'claude' })
    expect(res.status).toBe(404)
  })

  test('claude: returns file-shape payload that round-trips through ClaudeCredentialsFileSchema', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00.000Z')
    await seedProviderWithAccount({
      kind: 'claude',
      tokens: { accessToken: 'sk-ant-live-token', refreshToken: 'sk-ant-refresh' },
      scopes: ['user:inference', 'user:profile'],
      expiresAt
    })
    const res = await post({ provider: 'claude' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="claude-credentials.json"')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as { claudeAiOauth: Record<string, unknown> }
    expect(body.claudeAiOauth.accessToken).toBe('sk-ant-live-token')
    expect(body.claudeAiOauth.refreshToken).toBe('sk-ant-refresh')
    expect(body.claudeAiOauth.expiresAt).toBe(expiresAt.valueOf())
    expect(body.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile'])

    // Round-trip: the exported payload MUST parse back through the
    // schema import-credentials uses. If this drifts, backups break.
    const parsed = ClaudeCredentialsFileSchema.parse(body)
    expect(parsed.accessToken).toBe('sk-ant-live-token')
    expect(parsed.refreshToken).toBe('sk-ant-refresh')
    expect(parsed.expiresAt).toBe(expiresAt.valueOf())
    expect(parsed.scopes).toEqual(['user:inference', 'user:profile'])
  })

  test('claude: null expiresAt and no scopes still exports (schema defaults kick in on re-import)', async () => {
    await seedProviderWithAccount({
      kind: 'claude',
      tokens: { accessToken: 'sk-live', refreshToken: '' },
      scopes: undefined,
      expiresAt: null
    })
    const res = await post({ provider: 'claude' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { claudeAiOauth: { expiresAt: unknown; scopes: unknown; refreshToken: string } }
    expect(body.claudeAiOauth.expiresAt).toBeNull()
    expect(body.claudeAiOauth.scopes).toEqual([])
    // refresh defaults to '' when the DB row had none.
    expect(body.claudeAiOauth.refreshToken).toBe('')
    // Still round-trips.
    expect(() => ClaudeCredentialsFileSchema.parse(body)).not.toThrow()
  })

  test('codex: returns file-shape payload that round-trips through CodexCredentialsFileSchema', async () => {
    await seedProviderWithAccount({
      kind: 'codex',
      tokens: { accessToken: 'access-abc', refreshToken: 'refresh-def', idToken: 'id-ghi' }
    })
    const res = await post({ provider: 'codex' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="codex-auth.json"')

    const body = (await res.json()) as { tokens: { access_token: string; refresh_token: string; id_token: string } }
    expect(body.tokens.access_token).toBe('access-abc')
    expect(body.tokens.refresh_token).toBe('refresh-def')
    expect(body.tokens.id_token).toBe('id-ghi')

    const parsed = CodexCredentialsFileSchema.parse(body)
    expect(parsed.accessToken).toBe('access-abc')
    expect(parsed.refreshToken).toBe('refresh-def')
    expect(parsed.idToken).toBe('id-ghi')
  })

  test('codex: missing id_token → 409 (fail loudly rather than emit un-importable payload)', async () => {
    await seedProviderWithAccount({
      kind: 'codex',
      tokens: { accessToken: 'access-abc', refreshToken: 'refresh-def' }
      // idToken intentionally omitted
    })
    const res = await post({ provider: 'codex' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('id_token')
  })
})

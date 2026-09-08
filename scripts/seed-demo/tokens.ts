/**
 * Demo /v1 access tokens for Settings → Access.
 *
 * The rows are written directly rather than through issueAccessToken()
 * for two reasons: they need `demo-` ids so `--clean` can find them, and
 * the plaintext is generated, hashed and thrown away inside this function
 * so no working credential for this install ever exists — the screen gets
 * a populated list, and nobody gets a key.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { DEMO_PROFILE_KEY, demoId } from './demo-rows'
import type { Random } from './random'

const PREFIX = 'rialto_'
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

interface TokenSpec {
  name: string
  surface: string | null
  profileKey: string | null
  requestCount: number
  expiresInDays: number | null
  revoked: boolean
}

// Between them these cover every column the Access screen renders: an
// unscoped long-lived token, one pinned to a surface AND a profile, one
// with an expiry, and one revoked.
const TOKENS: TokenSpec[] = [
  { name: 'laptop (Claude Code)', surface: null, profileKey: null, requestCount: 1_284, expiresInDays: null, revoked: false },
  {
    name: 'ci-pipeline',
    surface: 'openai-chat',
    profileKey: DEMO_PROFILE_KEY,
    requestCount: 412,
    expiresInDays: 30,
    revoked: false
  },
  { name: 'scratch script', surface: null, profileKey: null, requestCount: 27, expiresInDays: 7, revoked: false },
  { name: 'old laptop', surface: null, profileKey: null, requestCount: 903, expiresInDays: null, revoked: true }
]

/** Returns the ids of the tokens traffic may be attributed to (not the revoked one). */
export async function seedAccessTokens(prisma: PrismaClient, random: Random, now: number): Promise<string[]> {
  const created: string[] = []
  for (const [idx, spec] of TOKENS.entries()) {
    const plaintext = `${PREFIX}${randomBytes(32).toString('hex')}`
    const id = demoId('token', idx + 1)
    await prisma.accessToken.create({
      data: {
        id,
        name: spec.name,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        prefix: plaintext.slice(0, PREFIX.length + 6),
        surface: spec.surface,
        profileKey: spec.profileKey,
        lastUsedAt: spec.revoked ? new Date(now - 9 * DAY_MS) : new Date(now - random.int(2, 240) * MINUTE_MS),
        requestCount: spec.requestCount,
        expiresAt: spec.expiresInDays === null ? null : new Date(now + spec.expiresInDays * DAY_MS),
        revokedAt: spec.revoked ? new Date(now - 6 * DAY_MS) : null,
        createdAt: new Date(now - random.int(20, 120) * DAY_MS)
      }
    })
    if (!spec.revoked) created.push(id)
  }
  return created
}

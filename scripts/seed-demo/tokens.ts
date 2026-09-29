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
  surfaces: string[]
  profileKey: string | null
  requestCount: number
  expiresInDays: number | null
}

// Between them these cover every column the Access screen renders: an
// unscoped long-lived token, one pinned to a single surface AND a
// profile, one pinned to two (the overflow count in the Endpoint cell
// has nothing to draw otherwise), and one with an expiry.
const TOKENS: TokenSpec[] = [
  {
    name: 'laptop (Claude Code)',
    surfaces: [],
    profileKey: null,
    requestCount: 1_284,
    expiresInDays: null
  },
  {
    name: 'ci-pipeline',
    surfaces: ['openai-chat'],
    profileKey: DEMO_PROFILE_KEY,
    requestCount: 412,
    expiresInDays: 30
  },
  // Codex speaks both, which is the case a single-surface pin could not
  // express without giving the client an unscoped token.
  {
    name: 'codex-cli',
    surfaces: ['openai-responses', 'openai-chat'],
    profileKey: null,
    requestCount: 738,
    expiresInDays: null
  },
  { name: 'scratch script', surfaces: [], profileKey: null, requestCount: 27, expiresInDays: 7 }
]

export const DEMO_TOKEN_COUNT = TOKENS.length

// A token revoked after it served traffic. Revoking deletes the row, so
// there is nothing to create; its id survives only on the requests it
// made, which is what the Usage screen's revoked-tokens line reads.
const REVOKED_TOKEN_ID = demoId('token', TOKENS.length + 1)

/** Returns the ids traffic may be attributed to, including the revoked token that has no row. */
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
        surfaces: spec.surfaces,
        profileKey: spec.profileKey,
        lastUsedAt: new Date(now - random.int(2, 240) * MINUTE_MS),
        requestCount: spec.requestCount,
        expiresAt: spec.expiresInDays === null ? null : new Date(now + spec.expiresInDays * DAY_MS),
        createdAt: new Date(now - random.int(20, 120) * DAY_MS)
      }
    })
    created.push(id)
  }
  return [...created, REVOKED_TOKEN_ID]
}

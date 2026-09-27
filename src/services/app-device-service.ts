/**
 * Access tokens for app installs, handed out against an Apple App Attest
 * attestation instead of by an operator.
 *
 * The app cannot ship a credential — anything in the binary is everyone's
 * — so it proves instead that it is the genuine, unmodified app on a real
 * Apple device, and gets a token of its own in return. Which apps may do
 * that, and which plan their installs start on, is the AuthorizedApp
 * table: the operator's decision, made on the Apps tab, never read from
 * the environment. What a token may spend is its plan's business.
 */

import { createHash, randomBytes } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { deleteAccessToken, issueAccessToken } from './access-token-service'
import { appleAppAttestRoot } from './app-attest/apple-root'
import { type AttestationPolicy, verifyAttestation } from './app-attest/verify-attestation'

// The surfaces an app token may call. The app speaks the Responses API;
// Chat Completions is allowed alongside so a client-side switch does not
// need every install re-registered.
const APP_SURFACES = ['openai-responses', 'openai-chat']

/** Whether any app may register right now. Until one is on, the endpoints answer 503. */
export async function registrationOpen(): Promise<boolean> {
  const count = await getPrismaClient()
    .authorizedApp.count({ where: { enabled: true } })
    .catch(() => 0)
  return count > 0
}

// Challenges are single-use and short-lived. In memory because Rialto
// runs as one process and a challenge lost to a restart only costs the
// app one retry; the cap bounds what a flood of challenge requests can
// hold.
const CHALLENGE_TTL_MS = 5 * 60_000
const challenges = new LRUCache<string, true>({ max: 10_000, ttl: CHALLENGE_TTL_MS })

export function issueChallenge(): { challenge: string; expiresInSeconds: number } {
  const challenge = randomBytes(32).toString('base64url')
  challenges.set(challenge, true)
  return { challenge, expiresInSeconds: CHALLENGE_TTL_MS / 1000 }
}

function consumeChallenge(challenge: string): boolean {
  const known = challenges.has(challenge)
  challenges.delete(challenge)
  return known
}

/** Tests only: an attestation fixture is bound to one fixed challenge string. */
export function __seedChallengeForTests(challenge: string): void {
  challenges.set(challenge, true)
}

export function __clearChallengesForTests(): void {
  challenges.clear()
}

export interface RegisterInput {
  keyId: string
  /** Base64 of the attestation object. */
  attestation: string
  challenge: string
}

export type RegisterResult =
  | {
      ok: true
      apiKey: string
      plan: string
      model: string
      dailyRequestLimit: number | null
      environment: string
    }
  | { ok: false; status: 400 | 409; reason: string }

/**
 * Verify an attestation and, if it holds, mint the install's token on its
 * app's plan.
 *
 * The client never says which app it is: the attestation carries the
 * app's identity as a hash, and the verifier matches it against the apps
 * that are switched on. The client data it attests is the challenge
 * string itself, so the hash checked is SHA-256 of its UTF-8 bytes.
 *
 * `policyOverride` exists for the tests, which cannot produce an
 * attestation Apple's root signed.
 */
export async function registerDevice(
  input: RegisterInput,
  policyOverride: Partial<Pick<AttestationPolicy, 'root' | 'now'>> = {}
): Promise<RegisterResult> {
  if (!consumeChallenge(input.challenge)) {
    return { ok: false, status: 400, reason: 'unknown or expired challenge' }
  }

  const prisma = getPrismaClient()
  const existing = await prisma.appDevice.findUnique({ where: { keyId: input.keyId } })
  if (existing !== null) return { ok: false, status: 409, reason: 'this key is already registered' }

  const apps = await prisma.authorizedApp.findMany({ where: { enabled: true }, include: { plan: true } })
  const verdict = verifyAttestation(
    {
      keyId: input.keyId,
      attestation: Buffer.from(input.attestation, 'base64'),
      clientDataHash: createHash('sha256').update(input.challenge, 'utf8').digest()
    },
    {
      apps,
      root: appleAppAttestRoot,
      now: dayjs().toDate(),
      ...policyOverride
    }
  )
  if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason }
  const app = apps.find((candidate) => candidate.appleAppId === verdict.appleAppId)
  if (app === undefined) return { ok: false, status: 400, reason: 'attestation is for an app that is not authorized' }

  const issued = await issueAccessToken({
    name: `${app.name} · ${input.keyId.slice(0, 8)}`,
    surfaces: APP_SURFACES,
    planId: app.planId
  })

  // The unique keyId is the real guard against one attested key minting
  // two tokens: the findUnique above can race a concurrent registration
  // of the same key, and whichever insert loses takes its token with it.
  const device = await prisma.appDevice
    .create({
      data: {
        keyId: input.keyId,
        publicKey: new Uint8Array(verdict.publicKey),
        environment: verdict.environment,
        authorizedAppId: app.id,
        accessTokenId: issued.token.id
      }
    })
    .catch(() => null)
  if (device === null) {
    await deleteAccessToken(issued.token.id)
    return { ok: false, status: 409, reason: 'this key is already registered' }
  }

  return {
    ok: true,
    apiKey: issued.plaintext,
    plan: app.plan.name,
    model: app.plan.defaultModel,
    dailyRequestLimit: app.plan.dailyRequestLimit,
    environment: verdict.environment
  }
}

/**
 * Access tokens for app installs, handed out against an Apple App Attest
 * attestation instead of by an operator.
 *
 * The app cannot ship a credential — anything in the binary is everyone's
 * — so it proves instead that it is the genuine, unmodified app on a real
 * Apple device, and gets a token of its own in return. What that token
 * may spend is decided here, by the plan, not by the client: every
 * request on it is pinned to one model and capped per day.
 *
 * Configured from the environment. Until both the app id and the free
 * plan's model are set the endpoints answer 503, so an install that has
 * not decided what free traffic may cost hands out nothing.
 *
 *   RIALTO_APP_ATTEST_APP_ID              `<Team ID>.<bundle id>`
 *   RIALTO_APP_ATTEST_ALLOW_DEVELOPMENT   'true' to accept debug builds' keys
 *   RIALTO_APP_FREE_MODEL                 model id free tokens are pinned to
 *   RIALTO_APP_FREE_DAILY_REQUESTS        per-day completion cap (default 100)
 */

import { createHash, randomBytes } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { deleteAccessToken, issueAccessToken } from './access-token-service'
import { appleAppAttestRoot } from './app-attest/apple-root'
import { type AttestationPolicy, verifyAttestation } from './app-attest/verify-attestation'

const FREE_PLAN = 'free'

const DEFAULT_FREE_DAILY_REQUESTS = 100

// The surfaces an app token may call. The app speaks the Responses API;
// Chat Completions is allowed alongside so a client-side switch does not
// need every install re-registered.
const APP_SURFACES = ['openai-responses', 'openai-chat']

export interface AppDeviceConfig {
  appId: string
  allowDevelopment: boolean
  freeModel: string
  freeDailyRequests: number
}

const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value.trim().length === 0 ? null : value.trim()

export function readAppDeviceConfig(env: NodeJS.ProcessEnv = process.env): AppDeviceConfig | null {
  const appId = nonEmpty(env.RIALTO_APP_ATTEST_APP_ID)
  const freeModel = nonEmpty(env.RIALTO_APP_FREE_MODEL)
  if (appId === null || freeModel === null) return null
  const rawLimit = nonEmpty(env.RIALTO_APP_FREE_DAILY_REQUESTS)
  const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit)
  return {
    appId,
    allowDevelopment: env.RIALTO_APP_ATTEST_ALLOW_DEVELOPMENT === 'true',
    freeModel,
    freeDailyRequests: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_FREE_DAILY_REQUESTS
  }
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
      dailyRequestLimit: number
      environment: string
    }
  | { ok: false; status: 400 | 409; reason: string }

/**
 * Verify an attestation and, if it holds, mint the install's token.
 *
 * The client data the app attests is the challenge string itself, so the
 * hash checked here is SHA-256 of its UTF-8 bytes — the app has to send
 * back exactly the string it was given.
 *
 * `policyOverride` exists for the tests, which cannot produce an
 * attestation Apple's root signed.
 */
export async function registerDevice(
  input: RegisterInput,
  config: AppDeviceConfig,
  policyOverride: Partial<AttestationPolicy> = {}
): Promise<RegisterResult> {
  if (!consumeChallenge(input.challenge)) {
    return { ok: false, status: 400, reason: 'unknown or expired challenge' }
  }

  const existing = await getPrismaClient().appDevice.findUnique({ where: { keyId: input.keyId } })
  if (existing !== null) return { ok: false, status: 409, reason: 'this key is already registered' }

  const verdict = verifyAttestation(
    {
      keyId: input.keyId,
      attestation: Buffer.from(input.attestation, 'base64'),
      clientDataHash: createHash('sha256').update(input.challenge, 'utf8').digest()
    },
    {
      appId: config.appId,
      allowDevelopment: config.allowDevelopment,
      root: appleAppAttestRoot,
      now: dayjs().toDate(),
      ...policyOverride
    }
  )
  if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason }

  const issued = await issueAccessToken({
    name: `app:${verdict.environment}:${input.keyId.slice(0, 12)}`,
    surfaces: APP_SURFACES,
    modelPin: config.freeModel,
    dailyRequestLimit: config.freeDailyRequests,
    plan: FREE_PLAN
  })

  // The unique keyId is the real guard against one attested key minting
  // two tokens: the findUnique above can race a concurrent registration
  // of the same key, and whichever insert loses takes its token with it.
  const device = await getPrismaClient()
    .appDevice.create({
      data: {
        keyId: input.keyId,
        publicKey: new Uint8Array(verdict.publicKey),
        environment: verdict.environment,
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
    plan: FREE_PLAN,
    model: config.freeModel,
    dailyRequestLimit: config.freeDailyRequests,
    environment: verdict.environment
  }
}

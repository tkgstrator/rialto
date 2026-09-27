/**
 * App Attest attestation verification against a throwaway CA.
 *
 * The fixture (`__tests__/fixtures/app-attest.json`) was minted with
 * OpenSSL: a P-384 root and intermediate standing in for Apple's, and per
 * case a P-256 leaf carrying the 1.2.840.113635.100.8.2 nonce over the
 * case's authenticator data and challenge. Nothing Apple signed can be
 * produced in a test, so the trust anchor is the one input swapped; every
 * other check runs exactly as in production.
 */

import { describe, expect, test } from 'bun:test'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import dayjs from '../../../src/lib/dayjs'
import { appleAppAttestRoot } from '../../../src/services/app-attest/apple-root'
import { decodeCbor } from '../../../src/services/app-attest/cbor'
import { type AttestationPolicy, verifyAttestation } from '../../../src/services/app-attest/verify-attestation'

const CaseSchema = z.object({ keyId: z.string().nonempty(), attestation: z.string().nonempty() })
const FixtureSchema = z.object({
  appId: z.string().nonempty(),
  challenge: z.string().nonempty(),
  rootPem: z.string().nonempty(),
  production: CaseSchema,
  development: CaseSchema,
  nonZeroCounter: CaseSchema
})

const loaded = FixtureSchema.safeParse(
  JSON.parse(readFileSync(join(import.meta.dir, '../../fixtures/app-attest.json'), 'utf8'))
)
if (!loaded.success) throw new Error(`app-attest fixture is malformed: ${loaded.error.message}`)
const fixture = loaded.data
const testRoot = new X509Certificate(fixture.rootPem)

const policy = (over: Partial<AttestationPolicy> = {}, allowDevelopment = false): AttestationPolicy => ({
  apps: [{ appleAppId: fixture.appId, allowDevelopment }],
  root: testRoot,
  now: dayjs('2030-01-01T00:00:00Z').toDate(),
  ...over
})

const input = (which: z.infer<typeof CaseSchema>, challenge = fixture.challenge) => ({
  keyId: which.keyId,
  attestation: Buffer.from(which.attestation, 'base64'),
  clientDataHash: createHash('sha256').update(challenge, 'utf8').digest()
})

describe('verifyAttestation', () => {
  test('accepts a production attestation and returns the attested key', () => {
    const result = verifyAttestation(input(fixture.production), policy())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.environment).toBe('production')
    expect(result.appleAppId).toBe(fixture.appId)
    // The key identifier is the SHA-256 of the returned key — the same
    // property the verifier checked, read back from the other side.
    expect(createHash('sha256').update(result.publicKey).digest('base64')).toBe(fixture.production.keyId)
  })

  test('refuses a chain that does not end at the configured root', () => {
    // Apple's real root: the fixture chain was not signed by it.
    const result = verifyAttestation(input(fixture.production), policy({ root: appleAppAttestRoot }))
    expect(result).toEqual({ ok: false, reason: 'certificate chain does not lead to the App Attest root' })
  })

  test('refuses a different challenge, so an attestation cannot be replayed', () => {
    const result = verifyAttestation(input(fixture.production, 'another-challenge'), policy())
    expect(result).toEqual({ ok: false, reason: 'nonce does not match the challenge' })
  })

  test('refuses an attestation minted for an app that is not authorized', () => {
    const result = verifyAttestation(
      input(fixture.production),
      policy({ apps: [{ appleAppId: 'OTHERTEAM1.jp.example.other', allowDevelopment: true }] })
    )
    expect(result).toEqual({ ok: false, reason: 'attestation is for an app that is not authorized' })
  })

  test('finds the attested app among several authorized ones', () => {
    const result = verifyAttestation(
      input(fixture.production),
      policy({
        apps: [
          { appleAppId: 'OTHERTEAM1.jp.example.other', allowDevelopment: false },
          { appleAppId: fixture.appId, allowDevelopment: false }
        ]
      })
    )
    expect(result.ok && result.appleAppId).toBe(fixture.appId)
  })

  test('refuses a key identifier that is not the attested key', () => {
    const result = verifyAttestation(
      { ...input(fixture.production), keyId: fixture.development.keyId },
      policy({}, true)
    )
    expect(result).toEqual({ ok: false, reason: 'key identifier does not match the attested key' })
  })

  test('refuses a development key unless development is allowed', () => {
    expect(verifyAttestation(input(fixture.development), policy())).toEqual({
      ok: false,
      reason: 'development attestations are not accepted'
    })
    const allowed = verifyAttestation(input(fixture.development), policy({}, true))
    expect(allowed.ok && allowed.environment).toBe('development')
  })

  test('refuses a key that has already signed something', () => {
    const result = verifyAttestation(input(fixture.nonZeroCounter), policy())
    expect(result).toEqual({ ok: false, reason: 'sign counter is not zero' })
  })

  test('refuses outside the certificates’ validity window', () => {
    const result = verifyAttestation(input(fixture.production), policy({ now: dayjs('2020-01-01T00:00:00Z').toDate() }))
    expect(result).toEqual({ ok: false, reason: 'certificate outside its validity period' })
  })

  test('refuses bytes that are not an attestation object', () => {
    const result = verifyAttestation({ ...input(fixture.production), attestation: Buffer.from('not cbor') }, policy())
    expect(result.ok).toBe(false)
  })
})

describe('decodeCbor', () => {
  test('reads the shapes an attestation object uses', () => {
    // {"a": [1, -2, h'0102'], "b": true}
    const value = decodeCbor(Uint8Array.from([0xa2, 0x61, 0x61, 0x83, 0x01, 0x21, 0x42, 0x01, 0x02, 0x61, 0x62, 0xf5]))
    expect(value).toEqual(
      new Map<string, unknown>([
        ['a', [1, -2, Uint8Array.from([1, 2])]],
        ['b', true]
      ])
    )
  })

  test('refuses indefinite lengths and truncation', () => {
    expect(() => decodeCbor(Uint8Array.from([0x5f]))).toThrow()
    expect(() => decodeCbor(Uint8Array.from([0x43, 0x01]))).toThrow()
  })

  test('refuses trailing bytes', () => {
    expect(() => decodeCbor(Uint8Array.from([0x01, 0x02]))).toThrow()
  })
})

describe('the embedded Apple root', () => {
  test('is the pinned App Attestation Root CA', () => {
    expect(appleAppAttestRoot.subject).toContain('Apple App Attestation Root CA')
    expect(appleAppAttestRoot.verify(appleAppAttestRoot.publicKey)).toBe(true)
  })
})

/**
 * Server-side verification of an Apple App Attest attestation object.
 *
 * Follows "Validating apps that connect to your server"
 * (developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server),
 * steps 1-9. Pure: no database, no clock of its own, no network — the
 * caller supplies the trust anchor, the time and the policy, which is
 * what lets the tests drive it with a throwaway CA.
 *
 * Every failure is a `{ ok: false, reason }`, never a throw, so the route
 * can answer one uniform 400 and log why without a try/catch that might
 * also swallow a programming error.
 */

import { createHash, X509Certificate } from 'node:crypto'
import { type CborMap, type CborValue, decodeCbor } from './cbor'
import { appAttestNonce, extensionValue } from './der'

const NONCE_OID = '1.2.840.113635.100.8.2'

// The AAGUID says which App Attest environment minted the key: a
// development build (Xcode, TestFlight excluded) or everything else.
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop', 'ascii')
const AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)])

export type AttestEnvironment = 'production' | 'development'

/** An app whose installs may register, as the verifier needs to see it. */
export interface AttestableApp {
  /** `<Team ID>.<bundle id>` — the authenticator data's RP ID hash is the SHA-256 of this. */
  appleAppId: string
  /** Accept keys minted by development builds. */
  allowDevelopment: boolean
}

export interface AttestationPolicy {
  /**
   * The apps that may register. The attestation names its app only as a
   * hash, so the verifier finds it here rather than trusting the client to
   * say which app it is.
   */
  apps: readonly AttestableApp[]
  /** Trust anchor the x5c chain must end at. */
  root: X509Certificate
  now: Date
}

export interface AttestationInput {
  /** The key identifier the app got from `generateKey()`, base64. */
  keyId: string
  /** The attestation object from `attestKey(_:clientDataHash:)`, raw bytes. */
  attestation: Uint8Array
  /** SHA-256 of the client data the app attested — here, of the challenge. */
  clientDataHash: Uint8Array
}

export type AttestationResult =
  | { ok: true; publicKey: Buffer; environment: AttestEnvironment; receipt: Buffer; appleAppId: string }
  | { ok: false; reason: string }

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256')
  parts.forEach((part) => {
    hash.update(part)
  })
  return hash.digest()
}

const fail = (reason: string): AttestationResult => ({ ok: false, reason })

const field = (map: CborMap, key: string): CborValue | undefined => map.get(key)

const isBytes = (value: CborValue | undefined): value is Uint8Array => value instanceof Uint8Array

const isMap = (value: CborValue | undefined): value is CborMap => value instanceof Map

const within = (cert: X509Certificate, now: Date): boolean =>
  cert.validFromDate.getTime() <= now.getTime() && now.getTime() <= cert.validToDate.getTime()

/**
 * The uncompressed P-256 point (0x04 || X || Y) of a certificate's key —
 * the form App Attest hashes into the key identifier.
 */
function uncompressedPoint(cert: X509Certificate): Buffer | null {
  const jwk = cert.publicKey.export({ format: 'jwk' })
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    return null
  }
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
}

interface AuthenticatorData {
  rpIdHash: Buffer
  signCount: number
  aaguid: Buffer
  credentialId: Buffer
}

// rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId
function parseAuthenticatorData(data: Buffer): AuthenticatorData | null {
  if (data.length < 55) return null
  const credentialLength = data.readUInt16BE(53)
  if (data.length < 55 + credentialLength) return null
  return {
    rpIdHash: data.subarray(0, 32),
    signCount: data.readUInt32BE(33),
    aaguid: data.subarray(37, 53),
    credentialId: data.subarray(55, 55 + credentialLength)
  }
}

function parseCertificate(bytes: Uint8Array): X509Certificate | null {
  try {
    return new X509Certificate(bytes)
  } catch {
    return null
  }
}

function decodeObject(bytes: Uint8Array): CborMap | null {
  try {
    const value = decodeCbor(bytes)
    return isMap(value) ? value : null
  } catch {
    return null
  }
}

function readNonce(certificate: X509Certificate): Buffer | null {
  try {
    const extension = extensionValue(certificate.raw, NONCE_OID)
    return extension === null ? null : Buffer.from(appAttestNonce(extension))
  } catch {
    return null
  }
}

type Failure = { ok: false; reason: string }

interface Statement {
  leaf: X509Certificate
  intermediate: X509Certificate
  authData: Buffer
  receipt: Buffer
}

// Unpack the attestation object down to the two certificates, the
// authenticator data and the receipt, or say which part is missing.
function readStatement(attestation: Uint8Array): Statement | Failure {
  const object = decodeObject(attestation)
  if (object === null) return { ok: false, reason: 'attestation is not a CBOR map' }
  if (field(object, 'fmt') !== 'apple-appattest') {
    return { ok: false, reason: 'attestation format is not apple-appattest' }
  }
  const statement = field(object, 'attStmt')
  const authData = field(object, 'authData')
  if (!isMap(statement) || !isBytes(authData)) {
    return { ok: false, reason: 'attestation is missing attStmt or authData' }
  }
  const x5c = field(statement, 'x5c')
  const receipt = field(statement, 'receipt')
  if (!Array.isArray(x5c) || x5c.length < 2 || !isBytes(receipt)) {
    return { ok: false, reason: 'attestation statement is incomplete' }
  }
  const [leafRaw, intermediateRaw] = x5c
  const leaf = isBytes(leafRaw) ? parseCertificate(leafRaw) : null
  const intermediate = isBytes(intermediateRaw) ? parseCertificate(intermediateRaw) : null
  if (leaf === null || intermediate === null) return { ok: false, reason: 'x5c certificate does not parse' }
  return { leaf, intermediate, authData: Buffer.from(authData), receipt: Buffer.from(receipt) }
}

// Step 1: credCert -> intermediate -> the root, every link signed by the
// next and every certificate inside its validity window.
function checkChain(statement: Statement, policy: AttestationPolicy): Failure | null {
  const { leaf, intermediate } = statement
  const chained =
    intermediate.checkIssued(policy.root) &&
    intermediate.verify(policy.root.publicKey) &&
    leaf.checkIssued(intermediate) &&
    leaf.verify(intermediate.publicKey)
  if (!chained) return { ok: false, reason: 'certificate chain does not lead to the App Attest root' }
  const current = [leaf, intermediate, policy.root].every((cert) => within(cert, policy.now))
  return current ? null : { ok: false, reason: 'certificate outside its validity period' }
}

const environmentOf = (aaguid: Buffer): AttestEnvironment | null => {
  if (aaguid.equals(AAGUID_PRODUCTION)) return 'production'
  if (aaguid.equals(AAGUID_DEVELOPMENT)) return 'development'
  return null
}

// Steps 6-9, read off the authenticator data.
function checkAuthenticatorData(
  authData: Buffer,
  keyId: Buffer,
  policy: AttestationPolicy
): { ok: true; environment: AttestEnvironment; app: AttestableApp } | Failure {
  const parsed = parseAuthenticatorData(authData)
  if (parsed === null) return { ok: false, reason: 'authenticator data is truncated' }
  // Step 6: minted for one of the authorized apps, and which one.
  const app = policy.apps.find((candidate) => parsed.rpIdHash.equals(sha256(Buffer.from(candidate.appleAppId, 'utf8'))))
  if (app === undefined) return { ok: false, reason: 'attestation is for an app that is not authorized' }
  // Step 7: a freshly attested key has never signed anything.
  if (parsed.signCount !== 0) return { ok: false, reason: 'sign counter is not zero' }
  // Step 8: which environment, and whether that one is accepted.
  const environment = environmentOf(parsed.aaguid)
  if (environment === null) return { ok: false, reason: 'unknown App Attest environment' }
  if (environment === 'development' && !app.allowDevelopment) {
    return { ok: false, reason: 'development attestations are not accepted' }
  }
  // Step 9: the credential is the same key.
  if (!parsed.credentialId.equals(keyId)) {
    return { ok: false, reason: 'credential id does not match the key identifier' }
  }
  return { ok: true, environment, app }
}

export function verifyAttestation(input: AttestationInput, policy: AttestationPolicy): AttestationResult {
  const statement = readStatement(input.attestation)
  if ('ok' in statement) return statement
  const chainFailure = checkChain(statement, policy)
  if (chainFailure !== null) return chainFailure

  // Steps 2-4: the nonce in the leaf binds this key to this challenge
  // and this authenticator data, so neither can be replayed with the other.
  const nonce = readNonce(statement.leaf)
  if (nonce === null || !nonce.equals(sha256(statement.authData, input.clientDataHash))) {
    return fail('nonce does not match the challenge')
  }

  // Step 5: the key identifier is the hash of the attested public key.
  const publicKey = uncompressedPoint(statement.leaf)
  if (publicKey === null) return fail('attested key is not P-256')
  const keyId = Buffer.from(input.keyId, 'base64')
  if (!sha256(publicKey).equals(keyId)) return fail('key identifier does not match the attested key')

  const checked = checkAuthenticatorData(statement.authData, keyId, policy)
  if (!checked.ok) return checked
  return {
    ok: true,
    publicKey,
    environment: checked.environment,
    receipt: statement.receipt,
    appleAppId: checked.app.appleAppId
  }
}

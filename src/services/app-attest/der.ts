/**
 * Just enough DER to pull one extension value out of a certificate.
 *
 * `node:crypto`'s X509Certificate verifies signatures and chains but does
 * not expose extensions, and the App Attest nonce lives in one
 * (OID 1.2.840.113635.100.8.2). The certificate has already been parsed
 * and signature-checked by X509Certificate before this runs, so this
 * walker only has to be correct on well-formed input — it still bounds
 * every length it reads, so a malformed one fails rather than reads out
 * of range.
 */

export class DerError extends Error {}

interface Tlv {
  tag: number
  /** Index of the first value byte. */
  start: number
  /** Index one past the last value byte. */
  end: number
}

function readTlv(bytes: Uint8Array, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new DerError('DER value runs past its container')
  const tag = bytes[offset]
  const first = bytes[offset + 1]
  if (first < 0x80) {
    const start = offset + 2
    if (start + first > limit) throw new DerError('DER value runs past its container')
    return { tag, start, end: start + first }
  }
  const width = first & 0x7f
  if (width === 0 || width > 4) throw new DerError('Unsupported DER length')
  if (offset + 2 + width > limit) throw new DerError('DER value runs past its container')
  const length = Array.from(bytes.subarray(offset + 2, offset + 2 + width)).reduce((acc, byte) => acc * 256 + byte, 0)
  const start = offset + 2 + width
  if (start + length > limit) throw new DerError('DER value runs past its container')
  return { tag, start, end: start + length }
}

/** The TLVs directly inside a constructed value, in order. */
function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const collect = (offset: number, acc: Tlv[]): Tlv[] => {
    if (offset >= parent.end) return acc
    const child = readTlv(bytes, offset, parent.end)
    return collect(child.end, [...acc, child])
  }
  return collect(parent.start, [])
}

const TAG_SEQUENCE = 0x30
const TAG_OID = 0x06
const TAG_OCTET_STRING = 0x04
// [3] EXPLICIT, the context tag tbsCertificate wraps its extensions in.
const TAG_EXTENSIONS = 0xa3

function oidBytes(oid: string): Uint8Array {
  const parts = oid.split('.').map(Number)
  const base128 = (value: number): number[] => {
    const digits = (rest: number, acc: number[]): number[] =>
      rest === 0 ? acc : digits(Math.floor(rest / 128), [rest % 128, ...acc])
    const raw = value === 0 ? [0] : digits(value, [])
    return raw.map((digit, index) => (index < raw.length - 1 ? digit | 0x80 : digit))
  }
  return Uint8Array.from([parts[0] * 40 + parts[1], ...parts.slice(2).flatMap(base128)])
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * The raw extnValue (the contents of its OCTET STRING) of the extension
 * with `oid`, or null when the certificate does not carry it.
 */
export function extensionValue(certificateDer: Uint8Array, oid: string): Uint8Array | null {
  const wanted = oidBytes(oid)
  const certificate = readTlv(certificateDer, 0, certificateDer.length)
  const [tbs] = children(certificateDer, certificate)
  if (tbs === undefined || tbs.tag !== TAG_SEQUENCE) throw new DerError('Certificate has no tbsCertificate')
  const wrapper = children(certificateDer, tbs).find((child) => child.tag === TAG_EXTENSIONS)
  if (wrapper === undefined) return null
  const [list] = children(certificateDer, wrapper)
  if (list === undefined || list.tag !== TAG_SEQUENCE) throw new DerError('Malformed extensions')

  const match = children(certificateDer, list).find((extension) => {
    const [id] = children(certificateDer, extension)
    return id !== undefined && id.tag === TAG_OID && sameBytes(certificateDer.subarray(id.start, id.end), wanted)
  })
  if (match === undefined) return null
  // extnID, optional critical BOOLEAN, extnValue — the value is always last.
  const parts = children(certificateDer, match)
  const value = parts[parts.length - 1]
  if (value === undefined || value.tag !== TAG_OCTET_STRING) throw new DerError('Malformed extension value')
  return certificateDer.subarray(value.start, value.end)
}

/**
 * The App Attest nonce inside the 1.2.840.113635.100.8.2 extension value:
 * `SEQUENCE { [1] EXPLICIT OCTET STRING nonce }`.
 */
export function appAttestNonce(extension: Uint8Array): Uint8Array {
  const sequence = readTlv(extension, 0, extension.length)
  if (sequence.tag !== TAG_SEQUENCE) throw new DerError('Malformed App Attest nonce extension')
  const tagged = children(extension, sequence).find((child) => child.tag === 0xa1)
  if (tagged === undefined) throw new DerError('App Attest nonce extension has no nonce')
  const [octets] = children(extension, tagged)
  if (octets === undefined || octets.tag !== TAG_OCTET_STRING) throw new DerError('Malformed App Attest nonce')
  return extension.subarray(octets.start, octets.end)
}

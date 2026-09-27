/**
 * The slice of CBOR (RFC 8949) an App Attest attestation object uses.
 *
 * Hand-rolled rather than a dependency because the attestation is the
 * only CBOR Rialto reads, and the subset it needs is small: unsigned and
 * negative integers, byte and text strings, arrays, maps with string or
 * integer keys, tags, and the simple values false / true / null. Anything
 * else — indefinite lengths, floats, undefined — is refused, so a crafted
 * object cannot reach a code path nobody here has read.
 */

export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | CborMap

export interface CborMap extends Map<string | number, CborValue> {}

export class CborError extends Error {}

// Nesting an attacker can make the decoder recurse through. An
// attestation object is three levels deep; this is generous and still
// far from any stack limit.
const MAX_DEPTH = 16

class Reader {
  offset = 0

  constructor(readonly bytes: Uint8Array) {}

  take(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.bytes.length) throw new CborError('CBOR value runs past the end')
    const slice = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return slice
  }

  uint(width: number): number {
    const bytes = this.take(width)
    const value = bytes.reduce((acc, byte) => acc * 256 + byte, 0)
    if (!Number.isSafeInteger(value)) throw new CborError('CBOR integer exceeds the safe range')
    return value
  }
}

function readArgument(reader: Reader, info: number): number {
  if (info < 24) return info
  if (info === 24) return reader.uint(1)
  if (info === 25) return reader.uint(2)
  if (info === 26) return reader.uint(4)
  if (info === 27) return reader.uint(8)
  // 28-30 are reserved, 31 is an indefinite length.
  throw new CborError(`Unsupported CBOR length encoding ${info}`)
}

const textDecoder = new TextDecoder('utf-8', { fatal: true })

function readItem(reader: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('CBOR nesting too deep')
  const [initial] = reader.take(1)
  const major = initial >> 5
  const info = initial & 0x1f

  if (major === 0) return readArgument(reader, info)
  if (major === 1) return -1 - readArgument(reader, info)
  if (major === 2) return reader.take(readArgument(reader, info))
  if (major === 3) return textDecoder.decode(reader.take(readArgument(reader, info)))
  if (major === 4) {
    const count = readArgument(reader, info)
    return Array.from({ length: count }, () => readItem(reader, depth + 1))
  }
  if (major === 5) {
    const count = readArgument(reader, info)
    const map: CborMap = new Map()
    Array.from({ length: count }).forEach(() => {
      const key = readItem(reader, depth + 1)
      if (typeof key !== 'string' && typeof key !== 'number') throw new CborError('Unsupported CBOR map key')
      map.set(key, readItem(reader, depth + 1))
    })
    return map
  }
  if (major === 6) {
    // A tag only annotates the item that follows; nothing here depends
    // on one, so it is read past.
    readArgument(reader, info)
    return readItem(reader, depth + 1)
  }
  if (info === 20) return false
  if (info === 21) return true
  if (info === 22) return null
  throw new CborError(`Unsupported CBOR simple value ${info}`)
}

/** Decode exactly one CBOR item that fills `bytes`. Throws CborError on anything else. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new Reader(bytes)
  const value = readItem(reader, 0)
  if (reader.offset !== bytes.length) throw new CborError('Trailing bytes after the CBOR item')
  return value
}

/**
 * Generated images, held briefly so the caller can save them to disk.
 *
 * An MCP tool result can show a model an image, but the model cannot turn
 * what it sees back into bytes, and the MCP server cannot write to the
 * caller's disk. So `generate_image` also returns a link, and the agent
 * downloads it with a plain HTTP GET (curl) into wherever it wants the
 * file.
 *
 * That GET carries no credential — putting the access token on a curl
 * command line would leave it in shell history and process lists — so
 * the key is the only thing guarding the file: 128 random bits, never
 * derived from the prompt or the caller, and forgotten after 15 minutes.
 * The same trade the suumo MCP server makes for its comparison pages.
 *
 * In process memory for the same reason as the threads: Rialto is one
 * process, and a link that outlives a restart is not worth a store.
 */

import { randomBytes } from 'node:crypto'
import { LRUCache } from 'lru-cache'

export const FILE_TTL_MS = 15 * 60 * 1000

interface StoredFile {
  bytes: Uint8Array
  mimeType: string
}

const files = new LRUCache<string, StoredFile>({
  max: 256,
  ttl: FILE_TTL_MS,
  maxSize: 256 * 1024 * 1024,
  sizeCalculation: (f) => Math.max(1, f.bytes.byteLength)
})

// base64url of 16 bytes is 22 characters from this alphabet. Checked before
// the map is touched, so a malformed key costs nothing.
const KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/

export function putFile(bytes: Uint8Array, mimeType: string): string {
  const key = randomBytes(16).toString('base64url')
  files.set(key, { bytes, mimeType })
  return key
}

export function getFile(key: string): StoredFile | null {
  if (!KEY_PATTERN.test(key)) return null
  const file = files.get(key)
  return file === undefined ? null : file
}

/**
 * The image type from its first bytes. The Codex backend returns PNG, but
 * the response does not say so and the request cannot choose, so the
 * bytes are what decides.
 */
export function sniffImageType(bytes: Uint8Array): string {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return 'image/png'
}

export function extensionFor(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

export function __clearFilesForTests(): void {
  files.clear()
}

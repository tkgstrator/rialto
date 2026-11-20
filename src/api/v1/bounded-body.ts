import type { Context } from 'hono'

export async function readBoundedBody(c: Context, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const length = Number(c.req.header('content-length'))
  if (Number.isFinite(length) && length > maxBytes) return null
  const reader = c.req.raw.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  const total = { bytes: 0 }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total.bytes += value.byteLength
    if (total.bytes > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

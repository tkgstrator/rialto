import { expect, test } from 'bun:test'
import { applyResponseModelIdentity } from '../../src/api/v1/response-model-identity'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const selectedIdentity = { provider: 'anthropic', model: 'claude-sonnet-5', path: '/v1/messages' }
const messageStart = 'event: message_start\ndata: {"type":"message_start","message":{"model":"upstream"}}\n\n'

const asSseResponse = (body: ReadableStream<Uint8Array>): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } })

const joinBytes = (chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  const state = { offset: 0 }
  for (const chunk of chunks) {
    result.set(chunk, state.offset)
    state.offset += chunk.byteLength
  }
  return result
}

const relayChunks = async (chunks: Uint8Array[]): Promise<Uint8Array> => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  const response = await applyResponseModelIdentity(asSseResponse(body), selectedIdentity)
  expect(response.headers.get('x-rialto-selected-model')).toBe('anthropic,claude-sonnet-5')
  return new Uint8Array(await response.arrayBuffer())
}

const patchedStart = messageStart.replace('upstream', 'anthropic,claude-sonnet-5')

const beforeRelease = async <Value>(operation: Promise<Value>): Promise<Value> => {
  const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined }
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        state.timer = setTimeout(() => reject(new Error('No byte progress before the upstream release barrier')), 1000)
      })
    ])
  } finally {
    clearTimeout(state.timer)
  }
}

test('forwards partial signature bytes before the upstream completes its event', async () => {
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const writer = source.writable.getWriter()
  const response = await applyResponseModelIdentity(asSseResponse(source.readable), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')

  try {
    const initialRead = reader.read()
    const [initial] = await beforeRelease(Promise.all([initialRead, writer.write(encoder.encode(messageStart))]))
    expect(decoder.decode(initial.value)).toContain('"model":"anthropic,claude-sonnet-5"')

    const partial = encoder.encode(
      'event: content_block_delta\ndata: {"delta":{"type":"signature_delta","signature":"pending'
    )
    const progress = reader.read()
    const [forwarded] = await beforeRelease(Promise.all([progress, writer.write(partial)]))
    expect(forwarded.value).toEqual(partial)
  } finally {
    await reader.cancel()
    await writer.close().catch(() => undefined)
  }
})

test('preserves all tail bytes including split UTF-8 and invalid opaque bytes', async () => {
  const tail = joinBytes([encoder.encode('data: あいう\r\n\r\n'), new Uint8Array([0xff, 0xfe, 0x80])])
  const initial = encoder.encode(messageStart)
  const shared = joinBytes([initial, tail.subarray(0, 8)])
  const result = await relayChunks([shared, tail.subarray(8, 9), tail.subarray(9)])
  expect(result).toEqual(joinBytes([encoder.encode(patchedStart), tail]))
})

test('handles every byte split of the initial LF and CRLF delimiters', async () => {
  for (const newline of ['\n', '\r\n']) {
    const initial = encoder.encode(messageStart.replaceAll('\n', newline))
    const tail = encoder.encode('event: content_block_delta\ndata: incomplete')
    const result = await relayChunks([...Array.from(initial, (byte) => new Uint8Array([byte])), tail])
    expect(result).toEqual(joinBytes([encoder.encode(patchedStart.replaceAll('\n', newline)), tail]))
  }
})

test('preserves ping and comment preludes before rewriting the initial envelope', async () => {
  const prelude = ': keep-alive\r\n\r\nevent: ping\ndata: {"type":"ping"}\n\n'
  const tail = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const result = await relayChunks([encoder.encode(prelude + messageStart + tail)])
  expect(decoder.decode(result)).toBe(prelude + patchedStart + tail)
})

test('aggregates multiline data and preserves non-data fields of the initial envelope', async () => {
  const initial =
    'id: msg_1\r\nevent: message_start\r\ndata: {"type":"message_start",\r\ndata: "message":{"model":"upstream"}}\r\n\r\n'
  const result = decoder.decode(await relayChunks([encoder.encode(initial)]))
  expect(result).toContain('id: msg_1\r\nevent: message_start\r\n')
  expect(result.endsWith('\r\n\r\n')).toBe(true)
  const rawData = result
    .split('\r\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  expect(JSON.parse(rawData)).toEqual({ type: 'message_start', message: { model: 'anthropic,claude-sonnet-5' } })
})

test('rewrites a split initial envelope with a missing or empty model', async () => {
  for (const message of [{}, { model: '' }]) {
    const initial = `data: ${JSON.stringify({ type: 'message_start', message })}\n\n`
    const result = decoder.decode(
      await relayChunks([encoder.encode(initial.slice(0, 10)), encoder.encode(initial.slice(10))])
    )
    expect(JSON.parse(result.slice(6))).toEqual({
      type: 'message_start',
      message: { model: 'anthropic,claude-sonnet-5' }
    })
  }
})

test('leaves opaque or error first records and every following byte unchanged', async () => {
  for (const initial of [
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\r\n\r\n',
    'data: not-json\n\n',
    'data: [DONE]\n\n'
  ]) {
    const bytes = encoder.encode(`${initial}${messageStart}unterminated`)
    expect(await relayChunks([bytes])).toEqual(bytes)
  }
})

test('preserves incomplete EOF without appending an event delimiter', async () => {
  const incomplete = encoder.encode('data: {"type":"message_start","message":{')
  expect(await relayChunks([incomplete])).toEqual(incomplete)
  const tail = encoder.encode('data: {"type":"message_stop"}')
  expect(await relayChunks([encoder.encode(messageStart), tail])).toEqual(
    joinBytes([encoder.encode(patchedStart), tail])
  )
})

test('does not count a large shared-chunk tail against the prefix limit', async () => {
  const tail = encoder.encode(`data: ${'x'.repeat(128 * 1024)}`)
  const result = await relayChunks([joinBytes([encoder.encode(messageStart), tail])])
  expect(result).toEqual(joinBytes([encoder.encode(patchedStart), tail]))
})

test('accepts a 64 KiB initial record and bypasses one byte over the limit', async () => {
  const prefix = 'data: {"type":"message_start","message":{"model":"upstream","padding":"'
  const suffix = '"}}'
  for (const extra of [0, 1]) {
    const record = prefix + 'x'.repeat(64 * 1024 - prefix.length - suffix.length + extra) + suffix
    const raw = `${record}\n\n`
    const result = decoder.decode(await relayChunks([encoder.encode(raw)]))
    expect(result).toBe(extra === 0 ? raw.replace('upstream', 'anthropic,claude-sonnet-5') : raw)
  }
})

test('forwards an unterminated oversized prefix before upstream EOF', async () => {
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const writer = source.writable.getWriter()
  const response = await applyResponseModelIdentity(asSseResponse(source.readable), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  const oversized = encoder.encode(`data: ${'x'.repeat(64 * 1024)}`)
  try {
    const progress = reader.read()
    const [forwarded] = await beforeRelease(Promise.all([progress, writer.write(oversized)]))
    expect(forwarded.value).toEqual(oversized)
  } finally {
    await reader.cancel()
    await writer.close().catch(() => undefined)
  }
})

test('allows exactly 32 preludes and bypasses after the 33rd prelude', async () => {
  for (const count of [32, 33]) {
    const prelude = ': ping\n\n'.repeat(count)
    const result = decoder.decode(await relayChunks([encoder.encode(prelude + messageStart)]))
    expect(result).toBe(prelude + (count === 32 ? patchedStart : messageStart))
  }
})

test('propagates downstream cancellation to the upstream source', async () => {
  const state: { reason: unknown } = { reason: undefined }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(messageStart))
    },
    cancel(reason) {
      state.reason = reason
    }
  })
  const response = await applyResponseModelIdentity(asSseResponse(source), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  await reader.read()
  await reader.cancel('owned-test-cancel')
  await Promise.resolve()
  expect(state.reason).toBe('owned-test-cancel')
})

test('propagates upstream errors without fabricating a terminal event', async () => {
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const writer = source.writable.getWriter()
  const response = await applyResponseModelIdentity(asSseResponse(source.readable), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  const firstRead = reader.read()
  await writer.write(encoder.encode(messageStart))
  expect(decoder.decode((await firstRead).value)).toBe(patchedStart)
  const nextRead = reader.read()
  const failure = new Error('synthetic-upstream-error')
  await writer.abort(failure)
  await expect(nextRead).rejects.toThrow('synthetic-upstream-error')
})

test('does not eagerly drain upstream while the downstream reader is idle', async () => {
  const state = { pulls: 0 }
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      controller.enqueue(encoder.encode(state.pulls === 1 ? messageStart : 'data: pending'))
      if (state.pulls === 20) controller.close()
    }
  })
  const response = await applyResponseModelIdentity(asSseResponse(source), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  try {
    await reader.read()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(state.pulls).toBeLessThanOrEqual(3)
  } finally {
    await reader.cancel()
  }
})

test('forwards each prelude while the initial envelope remains withheld', async () => {
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const writer = source.writable.getWriter()
  const response = await applyResponseModelIdentity(asSseResponse(source.readable), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  try {
    for (const prelude of [': keep-alive\r\n\r\n', 'data: {"type":"ping"}\n\n']) {
      const progress = reader.read()
      const [forwarded] = await beforeRelease(Promise.all([progress, writer.write(encoder.encode(prelude))]))
      expect(decoder.decode(forwarded.value)).toBe(prelude)
    }
  } finally {
    await reader.cancel()
    await writer.close().catch(() => undefined)
  }
})

test('propagates cancellation while an incomplete initial envelope is buffered', async () => {
  const state: { reason: unknown } = { reason: undefined }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"message_start"'))
    },
    cancel(reason) {
      state.reason = reason
    }
  })
  const response = await applyResponseModelIdentity(asSseResponse(source), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  const pendingRead = reader.read()
  await reader.cancel('owned-prefix-cancel')
  expect((await pendingRead).done).toBe(true)
  await Promise.resolve()
  expect(state.reason).toBe('owned-prefix-cancel')
})

test('propagates errors while an incomplete initial envelope is buffered', async () => {
  const state: { controller: ReadableStreamDefaultController<Uint8Array> | undefined } = { controller: undefined }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = controller
      controller.enqueue(encoder.encode('data: {"type":"message_start"'))
    }
  })
  const response = await applyResponseModelIdentity(asSseResponse(source), selectedIdentity)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response stream')
  const progress = reader.read()
  const checked = progress.then(
    () => undefined,
    (error: unknown) => error
  )
  state.controller?.error(new Error('synthetic-prefix-error'))
  const failure = await beforeRelease(checked)
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : undefined).toBe('synthetic-prefix-error')
})

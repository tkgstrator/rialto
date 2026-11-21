import { parseSseEvents } from '../../llms/utils/sse-aggregate/parse'

const MAX_EVENT_CHARS = 64 * 1024 * 1024

export function relayImageEditStream(
  upstream: ReadableStream<Uint8Array>,
  onCompleted: (event: Record<string, unknown>) => Promise<void>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const boundary = /\r?\n\r?\n/g
  let pending = ''
  let completed = false

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        controller.enqueue(chunk)
        if (completed) return

        boundary.lastIndex = Math.max(0, pending.length - 3)
        pending += decoder.decode(chunk, { stream: true })
        let start = 0
        for (let match = boundary.exec(pending); match !== null; match = boundary.exec(pending)) {
          const end = match.index
          const frame = end - start <= MAX_EVENT_CHARS ? pending.slice(start, end) : ''
          start = boundary.lastIndex
          for (const event of parseSseEvents(frame)) {
            if (
              event === null ||
              typeof event !== 'object' ||
              !('type' in event) ||
              event.type !== 'image_edit.completed'
            )
              continue
            completed = true
            pending = ''
            await onCompleted(event)
            return
          }
        }
        pending = pending.slice(start)
        // Bound accounting's buffer without changing what is sent to the client.
        if (pending.length > MAX_EVENT_CHARS) pending = ''
      }
    })
  )
}

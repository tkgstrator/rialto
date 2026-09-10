/**
 * SSE stream for new-log notifications.
 *
 * Authentication is `adminAuth` on /api/*, not here. EventSource cannot
 * set headers, and nothing needs it to: the stream is opened either by a
 * browser on this machine, which the gate exempts, or through Cloudflare
 * Access, whose assertion the edge attaches as it does to any request.
 */

import { requestLogsRoute } from './app'
import { type RequestLogEvent, requestLogEmitter } from './events'

// This handler used to re-check the envelope key inline, and that copy
// knew nothing about the local exemption or Cloudflare Access: on a
// machine where every other /api call succeeded, live updates alone
// returned 401. The `?apikey=` parameter it read went with the key.
requestLogsRoute.get('/api/request-logs/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: RequestLogEvent) => {
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
      }
      requestLogEmitter.on('new_log', send)
      // Heartbeat every 30 s to keep the connection alive through proxies.
      const hb = setInterval(() => controller.enqueue(': heartbeat\n\n'), 30_000)
      c.req.raw.signal.addEventListener('abort', () => {
        requestLogEmitter.off('new_log', send)
        clearInterval(hb)
        controller.close()
      })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  })
})

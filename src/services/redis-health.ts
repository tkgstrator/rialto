/**
 * Redis reachability, for `GET /health`.
 *
 * The Server settings screen has always had a Redis row and it always
 * read "not reported", because `/health` only ever probed the database.
 * The row is the only place an operator can see that usage capture and
 * the auth-health job have stopped running — both are fire-and-forget
 * (`startUsageCapture` / `startAuthHealthCheck` never block boot and log
 * once when Redis is down), so without this the queue can be dead for
 * days with nothing on screen to say so.
 *
 * Deliberately its own short-lived connection rather than a shared
 * client: the two job modules hold connections configured for BullMQ
 * (infinite retries, blocking commands), which is the opposite of what a
 * probe wants. One attempt, a hard timeout, and the socket is gone
 * again — a probe that retries in the background outlives the response
 * it was meant to describe.
 */

import IORedis from 'ioredis'
import { logger } from '../logger'

export type CheckState = 'ok' | 'fail' | 'skip'

// Both halves of the round trip are bounded: `connectTimeout` covers a
// host that never completes the handshake, `commandTimeout` a socket
// that connects and then goes quiet.
const PROBE_TIMEOUT_MS = 1_000

// An uptime monitor can hit /health every second; a down Redis would
// then write the same line every second. Warn on the way down and again
// only after it has recovered.
const warned = { down: false }

export async function checkRedis(): Promise<CheckState> {
  const url = process.env.REDIS_URL
  if (url === undefined || url.length === 0) return 'skip'

  const redis = new IORedis(url, {
    lazyConnect: true,
    // Without this a command issued while disconnected waits in a queue
    // for a reconnect that this probe has already given up on, which
    // turns the health check into a hang.
    enableOfflineQueue: false,
    connectTimeout: PROBE_TIMEOUT_MS,
    commandTimeout: PROBE_TIMEOUT_MS,
    // One attempt. Returning null stops ioredis reconnecting.
    retryStrategy: () => null
  })
  // ioredis emits 'error' on a failed connection, and an unhandled
  // 'error' event on an EventEmitter throws at the process level. The
  // rejected connect()/ping() below is the answer we actually act on.
  redis.on('error', () => {})

  try {
    await redis.connect()
    const reply = await redis.ping()
    if (warned.down) {
      warned.down = false
      logger.info('[health] Redis is reachable again')
    }
    return reply === 'PONG' ? 'ok' : 'fail'
  } catch (error) {
    if (!warned.down) {
      warned.down = true
      logger.warn({ err: error }, '[health] Redis is unreachable — usage capture and auth health are not running')
    }
    return 'fail'
  } finally {
    redis.disconnect()
  }
}

/**
 * Conversations `ask` can continue.
 *
 * MCP over stateless HTTP carries no session, and the Codex backend is
 * called with `store: false`, so neither side remembers a previous turn.
 * The history lives here and is sent in full on every turn, which is also
 * what lets a thread change model halfway through.
 *
 * In process memory, bounded by count, bytes and age, and gone on restart:
 * a review thread is worth keeping for a working session, not for a
 * database. Rialto runs as one process, so every call finds the same map.
 */

import { randomUUID } from 'node:crypto'
import { LRUCache } from 'lru-cache'

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

interface Thread {
  /** Only the token that started a thread may read or extend it. */
  ownerTokenId: string
  instructions: string | undefined
  turns: Turn[]
}

const THREAD_TTL_MS = 24 * 60 * 60 * 1000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

const threads = new LRUCache<string, Thread>({
  max: 1000,
  ttl: THREAD_TTL_MS,
  // Reading a thread to continue it is what should keep it alive.
  updateAgeOnGet: true,
  maxSize: MAX_TOTAL_BYTES,
  sizeCalculation: (t) =>
    Math.max(
      1,
      t.turns.reduce((sum, turn) => sum + turn.text.length * 2, 0)
    )
})

/**
 * A thread's history and instructions, or null when the id is unknown,
 * expired, or belongs to another token. The three are not told apart: a
 * caller holding someone else's id learns nothing from the answer.
 */
export function readThread(id: string, tokenId: string): { instructions: string | undefined; turns: Turn[] } | null {
  const thread = threads.get(id)
  if (thread === undefined || thread.ownerTokenId !== tokenId) return null
  return { instructions: thread.instructions, turns: thread.turns }
}

/**
 * The id a new thread will be saved under. A UUID because it also travels
 * to the Codex backend as the conversation's session id, which is what
 * Codex CLI sends there.
 */
export const newThreadId = (): string => randomUUID()

/** Record a completed turn. A thread only exists once it has one answer in it. */
export function saveThread(id: string, tokenId: string, instructions: string | undefined, turns: Turn[]): void {
  threads.set(id, { ownerTokenId: tokenId, instructions, turns })
}

export function __clearThreadsForTests(): void {
  threads.clear()
}

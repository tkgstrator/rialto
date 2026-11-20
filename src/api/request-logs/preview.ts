/**
 * Chat-style preview extraction for the session list — pulls a short
 * plain-text snippet out of the earliest archived user Message per
 * session.
 */

import { getPrismaClient } from '../../db/client'
import { normaliseContent } from '../../lib/sessions/message-content'

// Max chars kept in the session-list preview. Long enough for a full one-line
// prompt, short enough that we can ship it inside every SessionSummary row
// without bloating the /sessions payload.
const PREVIEW_MAX_CHARS = 160

// Pull a chat-style preview out of an archived user Message row. We reuse the
// same classifier the chat view uses (normaliseContent) and keep only the real
// `text` blocks, so framework-injected noise never leaks into the sidebar:
//   - <system-reminder> / <command-*> wrappers are stripped in place
//   - whole-block XML wrappers (e.g. <session>…</session>), JSON tool traffic,
//     [BRACKET MODE] instructions and tagless system dumps are classified as
//     system_text and dropped here
// A message that yields no real text (pure wrapper noise, or a tool_result-only
// turn echoing tool output back) returns null so loadPreviews falls through to
// the next user message for that session.
function extractPreview(content: unknown): string | null {
  const text = normaliseContent(content)
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text.length === 0) return null
  return truncatePreview(text)
}

function truncatePreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…` : text
}

// Per-session cap on user messages we scan for a preview. extractPreview
// returns null when the message is all framework-injected noise
// (<system-reminder> wrappers, tagless system dumps, tool_result-only
// turns) so we fall through to the next user message; this cap bounds
// that fallthrough. A session with 5000 turns must not stream 5000 JSONB
// payloads over the wire to yield one 160-char string.
const PREVIEW_SCAN_LIMIT = 5

// Fetch preview text for a batch of sessions in a single query. Grouped by
// sessionId → the earliest user Message row is returned per session.
export async function loadPreviews(sessionIds: string[]): Promise<Map<string, string | null>> {
  const previews = new Map<string, string | null>()
  if (sessionIds.length === 0) return previews
  const prisma = getPrismaClient()
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds }, firstUserInput: { not: null } },
    select: { id: true, firstUserInput: true }
  })
  for (const { id, firstUserInput } of sessions) {
    if (firstUserInput !== null) previews.set(id, truncatePreview(firstUserInput))
  }
  const historical = sessionIds.filter((id) => !previews.has(id))
  if (historical.length === 0) return previews
  // ROW_NUMBER window function caps the fetch at PREVIEW_SCAN_LIMIT user
  // messages per session inside Postgres — Prisma has no per-group LIMIT.
  const rows = await prisma.$queryRaw<Array<{ sessionId: string; content: unknown }>>`
    SELECT "sessionId", content FROM (
      SELECT "sessionId", content,
        ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "createdAt" ASC) AS rn
      FROM "Message"
      WHERE "sessionId" = ANY(${historical}) AND role = 'user'
    ) t
    WHERE rn <= ${PREVIEW_SCAN_LIMIT}
    ORDER BY "sessionId", rn`
  for (const row of rows) {
    if (previews.has(row.sessionId)) continue
    const preview = extractPreview(row.content)
    if (preview !== null) previews.set(row.sessionId, preview)
  }
  for (const id of sessionIds) if (!previews.has(id)) previews.set(id, null)
  return previews
}

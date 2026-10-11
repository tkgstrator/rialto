import { expect, test } from 'bun:test'
import { resolveSessionId } from '../../src/llms/pipeline/session-id'

// resolveSessionId only reads context.req.{headers,body}; a minimal shape
// is enough. Cast through unknown to satisfy the full TransformerContext.
const ctx = (req: unknown) => ({ req }) as unknown as Parameters<typeof resolveSessionId>[0]

test('resolveSessionId: x-claude-code-session-id header wins', () => {
  expect(resolveSessionId(ctx({ headers: { 'x-claude-code-session-id': 'sess-h' }, body: {} }))).toBe('sess-h')
})

test('resolveSessionId: thread_id header beats the cc-session header', () => {
  const c = ctx({ headers: { thread_id: 'th', 'x-claude-code-session-id': 'sess-h' }, body: {} })
  expect(resolveSessionId(c)).toBe('th')
})

// Codex CLI 0.158 sends it hyphenated.
test('resolveSessionId: the thread-id header is the thread_id header', () => {
  const c = ctx({ headers: { 'thread-id': 'th-new', 'x-claude-code-session-id': 'sess-h' }, body: {} })
  expect(resolveSessionId(c)).toBe('th-new')
})

test('resolveSessionId: extracts session_id from a JSON user_id blob', () => {
  const body = { metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: 'sess-b' }) } }
  expect(resolveSessionId(ctx({ headers: {}, body }))).toBe('sess-b')
})

test('resolveSessionId: extracts session_id from the legacy _session_ form', () => {
  const body = { metadata: { user_id: 'user_session_sess-legacy' } }
  expect(resolveSessionId(ctx({ headers: {}, body }))).toBe('sess-legacy')
})

test('resolveSessionId: no session info yields one memoized id per request context', () => {
  const c = ctx({ headers: {}, body: {} })
  const first = resolveSessionId(c)
  const second = resolveSessionId(c)
  // Same context (user turn + usage row + assistant turn) shares one id.
  expect(second).toBe(first)
  // A different request gets a different id.
  expect(resolveSessionId(ctx({ headers: {}, body: {} }))).not.toBe(first)
})

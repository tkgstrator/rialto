import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  archiveFile,
  archiveRequest,
  pruneArchive,
  requestArchiveEnabled,
  withoutSecrets
} from '../../src/llms/request-archive'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'archive-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const entry = (body: unknown) => ({
  reqId: 'r1',
  sessionId: 's1',
  path: '/v1/messages',
  headers: { authorization: 'Bearer secret', 'x-api-key': 'k', 'user-agent': 'claude-cli' },
  body,
  requestedModel: 'claude-sonnet-5-5',
  routedModel: 'openai,gpt-6.1-sol',
  route: 'think',
  isSubagent: false,
  tokenCount: 10
})

describe('request archive', () => {
  test('is off unless CAPTURE_FULL_REQUESTS is true', () => {
    expect(requestArchiveEnabled({})).toBe(false)
    expect(requestArchiveEnabled({ CAPTURE_FULL_REQUESTS: 'false' })).toBe(false)
    expect(requestArchiveEnabled({ CAPTURE_FULL_REQUESTS: 'true' })).toBe(true)
  })

  test('drops credential headers only', () => {
    expect(withoutSecrets(entry(null).headers)).toEqual({ 'user-agent': 'claude-cli' })
  })

  test('appends one gzip member per request, readable as JSONL, body verbatim', async () => {
    const dir = tmp()
    const now = new Date('2026-10-02T10:00:00Z')
    const body = {
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: '<RIALTO-SUBAGENT-MODEL>x</RIALTO-SUBAGENT-MODEL>' }
      ],
      messages: [{ role: 'user', content: 'こんにちは' }]
    }
    await archiveRequest(entry(body), dir, now)
    await archiveRequest(entry({ messages: [] }), dir, now)
    const lines = gunzipSync(readFileSync(archiveFile(now, dir)))
      .toString()
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] ?? '')
    expect(first.body).toEqual(body)
    expect(first.headers.authorization).toBeUndefined()
    expect(first.at).toBe('2026-10-02T10:00:00.000Z')
  })

  test('never throws when the directory is unwritable', async () => {
    await expect(archiveRequest(entry({}), '/proc/nope/archive')).resolves.toBeUndefined()
  })

  test('prunes day files older than 30 days and leaves everything else', async () => {
    const dir = tmp()
    for (const f of [
      'requests-2026-09-01.jsonl.gz',
      'requests-2026-09-02.jsonl.gz',
      'requests-2026-10-02.jsonl.gz',
      'notes.txt'
    ])
      writeFileSync(path.join(dir, f), 'x')
    const removed = await pruneArchive(dir, new Date('2026-10-02T10:00:00Z'))
    expect(removed).toEqual(['requests-2026-09-01.jsonl.gz'])
    expect(readdirSync(dir).sort()).toEqual([
      'notes.txt',
      'requests-2026-09-02.jsonl.gz',
      'requests-2026-10-02.jsonl.gz'
    ])
  })

  test('prunes a missing directory without throwing', async () => {
    await expect(pruneArchive('/nonexistent/archive')).resolves.toEqual([])
  })
})

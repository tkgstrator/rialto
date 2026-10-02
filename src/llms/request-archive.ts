/**
 * Full inbound request archive.
 *
 * RequestLog keeps metadata and Message keeps only the last user turn, which
 * is not enough to study how routing and subagent detection behave. When
 * CAPTURE_FULL_REQUESTS=true every inbound body is appended, verbatim, to a
 * daily JSONL file next to the logs. Each line is its own gzip member, so the
 * file stays append-only and `zcat requests-YYYY-MM-DD.jsonl.gz | jq` reads it.
 *
 * Credentials in headers are dropped; the body is stored as the client sent it.
 * Files older than ARCHIVE_RETENTION_DAYS (30) are deleted automatically.
 * Best-effort: never throws and never delays the request.
 */

import { mkdirSync } from 'node:fs'
import { appendFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import dayjs from '@/lib/dayjs'
import { HOME_DIR } from '@/shared/constants'

export const ARCHIVE_RETENTION_DAYS = 30

export const ARCHIVE_DIR = path.join(HOME_DIR, 'request-archive')

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization'])

export type ArchivedRequest = {
  reqId: string | undefined
  sessionId: string | undefined
  path: string
  headers: Record<string, string>
  /** The body exactly as received, before routing rewrote model/system. */
  body: unknown
  requestedModel: string | undefined
  routedModel: unknown
  route: string | undefined
  isSubagent: boolean | undefined
  tokenCount: number | undefined
}

export const requestArchiveEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.CAPTURE_FULL_REQUESTS === 'true'

export function withoutSecrets(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())))
}

export const archiveFile = (now: Date, dir: string = ARCHIVE_DIR): string =>
  path.join(dir, `requests-${now.toISOString().slice(0, 10)}.jsonl.gz`)

const FILE_PATTERN = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/

/**
 * Delete day files older than the retention window. The date comes from the
 * file name, not mtime, so a copied or touched file is judged by its day.
 * Returns the names removed. Best-effort: never throws.
 */
export async function pruneArchive(
  dir: string = ARCHIVE_DIR,
  now: Date = dayjs().toDate(),
  retentionDays: number = ARCHIVE_RETENTION_DAYS
): Promise<string[]> {
  const oldest = dayjs(now.getTime() - retentionDays * 86_400_000)
    .toDate()
    .toISOString()
    .slice(0, 10)
  const removed: string[] = []
  try {
    for (const name of await readdir(dir)) {
      const day = FILE_PATTERN.exec(name)?.[1]
      if (day === undefined || day >= oldest) continue
      await unlink(path.join(dir, name)).then(() => removed.push(name))
    }
  } catch {
    // A missing directory or a racing delete is not worth a failed request.
  }
  return removed
}

// Pruning runs at most once per UTC day per process, on the first archive write.
let prunedDay = ''

export async function archiveRequest(
  entry: ArchivedRequest,
  dir: string = ARCHIVE_DIR,
  now: Date = dayjs().toDate()
): Promise<void> {
  try {
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ at: now.toISOString(), ...entry, headers: withoutSecrets(entry.headers) })
    await appendFile(archiveFile(now, dir), gzipSync(`${line}\n`))
    const day = now.toISOString().slice(0, 10)
    if (prunedDay !== day) {
      prunedDay = day
      await pruneArchive(dir, now)
    }
  } catch {
    // Observation must not take a request down.
  }
}

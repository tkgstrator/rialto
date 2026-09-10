/**
 * Wire shape and pure helpers for the Settings sections that read and
 * write the on-disk config envelope (Server / Logging / Advanced).
 *
 * These screens deliberately do NOT reuse `ConfigProvider`'s normalized
 * `Config`: that shape coerces unset scalars to '' and drops the
 * envelope-only keys the sections edit (NON_INTERACTIVE_MODE, LOG_MAX_MB
 * — both ride ConfigEnvelopeSchema's catchall rather than the typed UI
 * schema). The raw `/api/config` document is the truth on disk, so that
 * is what gets fetched and rendered.
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

export const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']

/** The envelope keys these sections display or edit. */
export interface EnvelopeWire {
  HOST?: string
  PORT?: number
  LOG?: boolean
  LOG_LEVEL?: string
  /** Rotation size cap in megabytes; absent on disk means the logger's built-in default. */
  LOG_MAX_MB?: number
  PROXY_URL?: string | null
  API_TIMEOUT_MS?: number
  CLAUDE_PATH?: string | null
  NON_INTERACTIVE_MODE?: boolean
  /**
   * What the archive is allowed to keep. Absent means the server-side
   * default, which is ON for the two capture keys and OFF for redaction
   * — so a reader must not treat a missing key as false.
   */
  /** Cloudflare Access. Both are required together; either alone enables nothing. */
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  CAPTURE_REQUESTS?: boolean
  CAPTURE_MESSAGES?: boolean
  REDACT_TOOL_ARGUMENTS?: boolean
}

/** What the archive keeps, with the server's defaults applied. */
export interface CaptureSettings {
  CAPTURE_REQUESTS: boolean
  CAPTURE_MESSAGES: boolean
  REDACT_TOOL_ARGUMENTS: boolean
}

/**
 * Resolve the three capture keys against their server-side defaults.
 *
 * The asymmetry is the whole point: both capture keys default ON, so an
 * absent key means "recording", and reading it as false would have the
 * screen report capture disabled on an install that is recording
 * normally. Redaction defaults OFF for the opposite reason — it destroys
 * information irreversibly, so it is never on unless someone said so.
 */
export function captureSettings(w: EnvelopeWire): CaptureSettings {
  return {
    CAPTURE_REQUESTS: w.CAPTURE_REQUESTS !== false,
    CAPTURE_MESSAGES: w.CAPTURE_MESSAGES !== false,
    REDACT_TOOL_ARGUMENTS: w.REDACT_TOOL_ARGUMENTS === true
  }
}

/** src/logger.ts falls back to this when LOG_MAX_MB is absent from the envelope. */
export const DEFAULT_LOG_MAX_MB = 10

/** Fixed-width stand-in for a secret. Never derived from the secret's length. */
export const SECRET_MASK = '••••••••••••••••••••'

/** Optional scalar for a read-only field: the value, or the word `unset`. */
export function orUnset(value: string | null | undefined): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unset'
}

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/**
 * Byte counts at the precision the retention table reads at: one decimal
 * below ten so `9.4 MB` keeps its resolution, none above so `412 MB`
 * doesn't pretend to a precision the number doesn't have.
 */
export function fmtBytes(bytes: number): string {
  const scale = bytes >= GB ? GB : bytes >= MB ? MB : bytes >= KB ? KB : 1
  const unit = bytes >= GB ? 'GB' : bytes >= MB ? 'MB' : bytes >= KB ? 'KB' : 'B'
  const n = bytes / scale
  if (scale === 1) return `${Math.round(n)} B`
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`
}

/** Total on-disk size across the archive stores. */
export function totalBytes(stores: readonly { bytes: number }[]): number {
  return stores.reduce((total, s) => total + s.bytes, 0)
}

/**
 * A numeric text field's value on the way back into the envelope.
 * Returns null for anything that isn't a non-negative integer so the
 * caller can refuse the save instead of writing NaN to disk.
 */
export function parseCount(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(n) ? n : null
}

/** True when the text parses as JSON — drives the valid/invalid pill. */
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Pretty-printed JSON, or null when the text does not parse. */
export function formatJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

/** Line count used to size the editor's gutter. */
export function lineNumbers(text: string): number[] {
  return text.split('\n').map((_, i) => i + 1)
}

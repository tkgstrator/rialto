/**
 * Pino line parsing for Activity › Logs.
 *
 * The server hands back raw JSON lines; turning them into rows has always
 * been the client's job. It happens here synchronously instead of in the
 * old inline Web Worker — the payload is capped at 5000 lines, which
 * parses in a few milliseconds, and a Blob worker cost more in moving
 * parts than it saved.
 *
 * The unit of reading is the line. Grouping by request id used to live
 * here, on the premise that a request produces a story worth folding
 * together; it produces at most two lines, so the fold was a disclosure
 * arrow in front of a single row.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

// Fields the line renderer prints in its own columns, so they must not be
// repeated in the trailing key=value run.
const RENDERED_KEYS = new Set(['level', 'time', 'timestamp', 'msg', 'reqId', 'pid', 'hostname'])

const MAX_VALUE_CHARS = 120

export interface LogLine {
  key: string
  level: LogLevel
  time: number
  msg: string
  reqId: string | null
  /** Access-log fields, present only on lines the HTTP middleware wrote. */
  method: string | null
  path: string | null
  status: number | null
  /** `provider,model`, present only on upstream send/receive lines. */
  target: string | null
  /** The untouched line, for search and download. */
  raw: string
}

const isLevel = (value: unknown): value is LogLevel => typeof value === 'string' && LOG_LEVELS.some((l) => l === value)

function readString(source: object, key: string): string | null {
  const value = Reflect.get(source, key)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(source: object, key: string): number | null {
  const value = Reflect.get(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toObject(raw: string): object | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // A truncated tail or a non-pino line: rendered verbatim rather than dropped.
  }
  return null
}

function renderValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return String(value)
  const json = JSON.stringify(value)
  const text = typeof json === 'string' ? json : String(value)
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
}

/**
 * The rest of the line as `key=value`, which is how pino reads by eye.
 *
 * Built on render, not on parse: at debug level a single line carries a
 * whole request body, and serialising 5000 of those up front to throw
 * away all but 120 characters each is the one part of this file that
 * could stall the tab.
 */
export function lineDetail(raw: string): string {
  const source = toObject(raw)
  if (source === null) return ''
  return Object.entries(source)
    .filter(([key]) => !RENDERED_KEYS.has(key))
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(' ')
}

function readTarget(source: object): string | null {
  const type = Reflect.get(source, 'type')
  const scope = type === 'request body' ? Reflect.get(source, 'data') : source
  if (type !== 'request body' && type !== 'response') return null
  if (scope === null || typeof scope !== 'object') return null
  const provider = readString(scope, 'provider')
  if (provider === null) return null
  const model = readString(scope, 'model')
  return model === null ? provider : `${provider},${model}`
}

export function parseLogLines(raw: string[]): LogLine[] {
  return raw.map((line, index) => {
    const source = toObject(line)
    if (source === null) {
      return {
        key: `l${index}`,
        level: 'info',
        time: 0,
        msg: line,
        reqId: null,
        method: null,
        path: null,
        status: null,
        target: null,
        raw: line
      }
    }
    const level = Reflect.get(source, 'level')
    const time = readNumber(source, 'time')
    const msg = readString(source, 'msg')
    return {
      key: `l${index}`,
      level: isLevel(level) ? level : 'info',
      time: time === null ? 0 : time,
      msg: msg === null ? '' : msg,
      reqId: readString(source, 'reqId'),
      method: readString(source, 'method'),
      path: readString(source, 'path'),
      status: readNumber(source, 'status'),
      target: readTarget(source),
      raw: line
    }
  })
}

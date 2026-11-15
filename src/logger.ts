/**
 * Shared pino logger. Verbosity is controlled solely by LOG_LEVEL; file output
 * by LOG. No content-based filtering — a plain configured pino instance.
 *
 * Consumed by the app-side LLM pipeline (src/llms) as `ctx.log` and as
 * the pino logger threaded into every transformer; `logger.child({ reqId })` in
 * sendToProvider groups one request's lines for the UI LogViewer.
 * For Hono-side request logging, pino's official pattern is
 * `@hono/structured-logger` + `logger.child({ requestId })` (docs/web.md#hono).
 */
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import pinoPretty from 'pino-pretty'
import dayjs from '@/lib/dayjs'
import { LoggerEnvSchema } from '@/schemas/primitives/env'
import { LOG_DIR } from '@/shared/constants'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'

// Env-driven logger state re-derived from process.env. Kept behind a
// mutable holder so `syncLoggerFromEnv()` can refresh it whenever the
// disk envelope changes (a UI save re-parses config.json into
// process.env via applyEnvelopeToEnv). Without this, LOG (file-output
// gate) and LOG_MAX_MB (rotation size) freeze at boot and no UI edit
// takes effect until the server restarts.
const runtimeConfig = {
  env: LoggerEnvSchema.parse(process.env),
  // Derived from env.LOG_MAX_MB; refreshed alongside env by
  // syncLoggerFromEnv so a UI change of LOG_MAX_MB re-sizes the
  // rotation cap without a restart.
  logMaxBytes: 0
}
runtimeConfig.logMaxBytes = runtimeConfig.env.LOG_MAX_MB * 1024 * 1024

const SIMPLE_REDACT_KEYS = [
  'authorization',
  'Authorization',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'token',
  'secret',
  'password',
  'cookie',
  'Cookie'
]

const REDACT_PATHS = [
  ...SIMPLE_REDACT_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`, `*.*.*.*.${key}`]),
  'headers["x-api-key"]',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers.cookie',
  'req.headers.Cookie',
  'req.headers["x-api-key"]',
  'req.headers["set-cookie"]',
  'data.headers.authorization',
  'data.headers.Authorization',
  'data.headers.cookie',
  'data.headers.Cookie',
  'data.headers["x-api-key"]',
  'data.headers["set-cookie"]'
]

// Size-based rotation on top of the daily cadence. When the active file
// grows past LOG_MAX_MB, subsequent writes go to `YYYY-MM-DD-N.log`
// with an incrementing suffix, so a single busy day produces a series
// of digestible files instead of one multi-hundred-MB blob. A restart
// mid-day resumes at the highest existing suffix. The cap itself lives
// on runtimeConfig.logMaxBytes so a UI change of LOG_MAX_MB takes
// effect on the next line write.

const rotationState = {
  date: '',
  seq: 0,
  bytes: 0
}

const rotationPath = (date: string, seq: number): string => {
  const suffix = seq === 0 ? '' : `-${seq}`
  // The directory (~/.rialto/logs) already scopes these files to Rialto,
  // so the name itself only needs the date.
  return path.join(LOG_DIR, `${date}${suffix}.log`)
}

// The log directory is created on the first line actually written to
// disk, not at import time. Import-time creation materialised the whole
// home directory before src/index.ts could run migrateHomeDir(), whose
// idempotency guard is "the destination exists" — so the copy from the
// pre-rename home would have been skipped on every boot. It also means
// a deployment with LOG=false no longer gets an empty logs/ directory.
const ensureRotationForDate = (date: string): void => {
  if (date === rotationState.date) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    /* logging must never throw */
  }
  rotationState.date = date
  rotationState.seq = 0
  while (existsSync(rotationPath(date, rotationState.seq + 1))) rotationState.seq++
  try {
    rotationState.bytes = statSync(rotationPath(date, rotationState.seq)).size
  } catch {
    rotationState.bytes = 0
  }
}

const fileStream = {
  write(line: string): void {
    if (!runtimeConfig.env.LOG) return
    const date = dayjs().format('YYYY-MM-DD')
    ensureRotationForDate(date)
    if (rotationState.bytes + line.length > runtimeConfig.logMaxBytes) {
      rotationState.seq++
      rotationState.bytes = 0
    }
    try {
      appendFileSync(rotationPath(rotationState.date, rotationState.seq), line)
      rotationState.bytes += line.length
    } catch {
      /* logging must never throw */
    }
  }
}

// File stays raw JSON (LogViewer / logs API parse each line as JSON). Console
// is prettified only. `time` is epoch ms from our timestamp hook; translateTime
// renders it readably and `timestamp` (the redundant ISO field) is dropped.
const consoleStream = pinoPretty({
  colorize: true,
  translateTime: 'SYS:standard',
  ignore: 'timestamp'
})

// Plain combined stream instead of pino.multistream: multistream fixes its
// internal minLevel at construction time, so logger.level changes made after
// creation (e.g. syncLoggerFromEnv) are silently ignored. A plain write()
// shim delegates entirely to pino's own level gate, which IS updated by
// logger.level assignments.
const combinedStream = {
  write(line: string): void {
    fileStream.write(line)
    consoleStream.write(line)
  }
}

export const logger = pino(
  {
    level: runtimeConfig.env.LOG_LEVEL,
    base: null,
    messageKey: 'msg',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label })
    },
    timestamp: () => {
      const now = dayjs()
      return `,"time":${now.valueOf()},"timestamp":"${now.toISOString()}"`
    }
  },
  combinedStream
)

// Refresh every env-driven bit of logger state (LOG_LEVEL / LOG /
// LOG_MAX_MB) from the current process.env. Called from src/index.ts
// after initConfig() first mirrors config.json onto process.env, and
// again from applyUiConfig() after a UI save updates the envelope so
// changes take effect without a server restart. Both the pino level
// gate and the file-write / rotation gates read runtimeConfig on every
// line, so re-parsing here is enough to make them reactive.
export const syncLoggerFromEnv = () => {
  runtimeConfig.env = LoggerEnvSchema.parse(process.env)
  runtimeConfig.logMaxBytes = runtimeConfig.env.LOG_MAX_MB * 1024 * 1024
  const raw = process.env.LOG_LEVEL ?? ''
  const valid = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']
  if (valid.includes(raw)) logger.level = raw
  logger.info(
    { LOG_LEVEL: logger.level, LOG: runtimeConfig.env.LOG, LOG_MAX_MB: runtimeConfig.env.LOG_MAX_MB },
    'log config applied'
  )
}

export { LOG_DIR }

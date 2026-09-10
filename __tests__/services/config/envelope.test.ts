/**
 * readConfigFile — JSON5 parsing and environment variable interpolation.
 * applyEnvelopeToEnv — scalar mirroring onto process.env.
 *
 * These assert what the DISK file produces, and readConfigFile overlays
 * process.env on top of it before parsing. Any envelope scalar left on
 * process.env by another test file therefore changes the answer — which
 * is what made this suite pass alone and fail eight ways in a full run:
 * a stray API_TIMEOUT_MS meant "absent from the file" came back as
 * 30000. Every case here clears the envelope keys first, so the suite
 * measures the file rather than whatever ran before it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { applyEnvelopeToEnv, readConfigFile } from '../../../src/services/config/envelope'
import { CONFIG_FILE } from '../../../src/shared/constants'
import { SEED_PERSONAS } from '../../../src/shared/data'
import { ENVELOPE_ENV_KEYS } from '../../../src/shared/db/types'

async function writeConfig(content: string): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, content)
}

async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(CONFIG_FILE)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

// Snapshot taken once, at import, before any case has run.
const savedEnv = new Map(ENVELOPE_ENV_KEYS.map((key) => [key, process.env[key]]))

function clearEnvelopeEnv(): void {
  for (const key of ENVELOPE_ENV_KEYS) delete process.env[key]
}

function restoreEnvelopeEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function resetEnvAndConfig(): Promise<void> {
  clearEnvelopeEnv()
  await deleteConfig()
}

describe('readConfigFile', () => {
  beforeEach(resetEnvAndConfig)
  afterEach(async () => {
    restoreEnvelopeEnv()
    await deleteConfig()
  })

  test('parses standard JSON', async () => {
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'test-key' }))
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(3456)
    expect(cfg.LOG).toBe(false)
  })

  test('parses JSON5 with comments and trailing commas', async () => {
    await writeConfig(`{
      // server port
      PORT: 3456,
      LOG: true, // trailing comma
      LOG_LEVEL: 'info',
      APIKEY: 'test-key',
    }`)
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(3456)
    expect(cfg.LOG).toBe(true)
  })

  test('interpolates $VAR_NAME', async () => {
    process.env.TEST_RIALTO_KEY = 'sk-real'
    await writeConfig(JSON.stringify({ LOG: false, LOG_LEVEL: 'info', APIKEY: '$TEST_RIALTO_KEY' }))
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('sk-real')
    delete process.env.TEST_RIALTO_KEY
  })

  test('interpolates ${VAR_NAME}', async () => {
    process.env.TEST_RIALTO_HOST = '0.0.0.0'
    await writeConfig(
      JSON.stringify({ HOST: '${TEST_RIALTO_HOST}', LOG: false, LOG_LEVEL: 'info', APIKEY: 'test-key' })
    )
    const cfg = await readConfigFile()
    expect(cfg.HOST).toBe('0.0.0.0')
    delete process.env.TEST_RIALTO_HOST
  })

  test('keeps literal when env var is unset', async () => {
    delete process.env.UNSET_RIALTO_VAR
    await writeConfig(JSON.stringify({ LOG: false, LOG_LEVEL: 'info', APIKEY: '$UNSET_RIALTO_VAR' }))
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('$UNSET_RIALTO_VAR')
  })

  test('interpolates env vars inside nested objects and arrays', async () => {
    process.env.TEST_RIALTO_BASE = 'https://api.example.com'
    await writeConfig(
      JSON.stringify({
        LOG: false,
        LOG_LEVEL: 'info',
        APIKEY: 'test-key',
        Providers: [{ name: 'test', api_base_url: '$TEST_RIALTO_BASE' }]
      })
    )
    const cfg = (await readConfigFile()) as Record<string, unknown>
    const providers = cfg.Providers as { api_base_url: string }[]
    expect(providers[0].api_base_url).toBe('https://api.example.com')
    delete process.env.TEST_RIALTO_BASE
  })

  test('returns default config when file does not exist', async () => {
    const cfg = await readConfigFile()
    expect(cfg).toMatchObject({ PORT: expect.any(Number), Providers: [] })
    // Fresh installs ship with the seed persona library.
    expect(cfg.Personas).toEqual(SEED_PERSONAS)
  })
})

describe('readConfigFile — API_TIMEOUT_MS handling', () => {
  beforeEach(resetEnvAndConfig)
  afterEach(async () => {
    restoreEnvelopeEnv()
    await deleteConfig()
  })

  test('string API_TIMEOUT_MS is coerced to number and config is not deleted', async () => {
    // Pre-fix configs written by the old UI stored API_TIMEOUT_MS as a string.
    // z.coerce.number() ensures those files survive startup rather than being
    // wiped and recreated as a default config (which loses all other settings).
    await writeConfig(
      JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'key', API_TIMEOUT_MS: '30000' })
    )
    const cfg = await readConfigFile()
    // readConfigFile returns the schema-parsed envelope, so API_TIMEOUT_MS
    // is coerced to a number. The important guarantee is that the file does
    // NOT fall back to createDefaultConfig() — APIKEY is preserved.
    expect(cfg.APIKEY).toBe('key')
    expect(cfg.PORT).toBe(3456)
    expect(cfg.API_TIMEOUT_MS).toBe(30000)
  })

  test('number API_TIMEOUT_MS is accepted and returned as-is', async () => {
    await writeConfig(
      JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'key', API_TIMEOUT_MS: 30000 })
    )
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBe(30000)
  })

  test('absent API_TIMEOUT_MS is valid (field is optional)', async () => {
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'key' }))
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBeUndefined()
    // Config was NOT recreated — original settings are preserved.
    expect(cfg.APIKEY).toBe('key')
  })

  // These two used to assert that a rejected config "is lost, but a new
  // one is generated" — the behaviour that rotated an operator's
  // bootstrap token because one field failed validation, locking out
  // every configured client. The invalid field is still dropped; what
  // must survive is the credential.
  test('a negative API_TIMEOUT_MS is dropped without taking the token with it', async () => {
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'key', API_TIMEOUT_MS: -1 }))
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBeUndefined()
    expect(cfg.APIKEY).toBe('key')
  })

  test('a non-numeric API_TIMEOUT_MS is dropped without taking the token with it', async () => {
    await writeConfig(
      JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'key', API_TIMEOUT_MS: 'fast' })
    )
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('key')
  })

  test('"600000" (old UI default value as string) does not destroy config', async () => {
    const originalApikey = 'my-production-apikey'
    await writeConfig(
      JSON.stringify({
        PORT: 3456,
        LOG: true,
        LOG_LEVEL: 'debug',
        APIKEY: originalApikey,
        API_TIMEOUT_MS: '600000'
      })
    )
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe(originalApikey)
    expect(cfg.LOG).toBe(true)
    expect(cfg.LOG_LEVEL).toBe('debug')
    // The string value is coerced to a number on the returned envelope.
    expect(cfg.API_TIMEOUT_MS).toBe(600000)
  })
})

describe('readConfigFile — env overlay (12-factor)', () => {
  beforeEach(resetEnvAndConfig)
  afterEach(async () => {
    restoreEnvelopeEnv()
    await deleteConfig()
  })

  test('process.env value overrides the disk envelope APIKEY', async () => {
    process.env.APIKEY = 'from-env'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'from-disk' }))
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('from-env')
    delete process.env.APIKEY
  })

  test('empty-string env value does NOT override the disk envelope', async () => {
    // A stray `APIKEY=` in a .env file should not silently disable auth
    // by overwriting a real disk-stored key.
    process.env.APIKEY = ''
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'from-disk' }))
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('from-disk')
    delete process.env.APIKEY
  })

  test('numeric envelope keys from env are coerced to numbers before schema parse', async () => {
    process.env.PORT = '9999'
    process.env.API_TIMEOUT_MS = '15000'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'k' }))
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(9999)
    expect(cfg.API_TIMEOUT_MS).toBe(15000)
    delete process.env.PORT
    delete process.env.API_TIMEOUT_MS
  })

  test('boolean envelope keys accept "true" / "1" from env', async () => {
    process.env.LOG = 'true'
    process.env.NON_INTERACTIVE_MODE = '1'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', APIKEY: 'k' }))
    const cfg = await readConfigFile()
    expect(cfg.LOG).toBe(true)
    expect(cfg.NON_INTERACTIVE_MODE).toBe(true)
    delete process.env.LOG
    delete process.env.NON_INTERACTIVE_MODE
  })

  test('env APIKEY satisfies the required field when disk config omits it', async () => {
    // The docker-compose deployment pattern: mount a minimal config
    // that leaves APIKEY unset and pass it purely via env. Without the
    // overlay the schema would fail (nonempty required) and the file
    // would get wiped by the fall-back-to-defaults path.
    process.env.APIKEY = 'from-env-only'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info' }))
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('from-env-only')
    // Config was NOT wiped: the original PORT survived.
    expect(cfg.PORT).toBe(3456)
    delete process.env.APIKEY
  })

  test('env APIKEY wins over the generated random APIKEY on default-config creation', async () => {
    // No config file on disk (fresh container). The default-config path
    // usually generates a random APIKEY; env should still override the
    // returned runtime value.
    process.env.APIKEY = 'deploy-provided'
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('deploy-provided')
    delete process.env.APIKEY
  })
})

describe('readConfigFile — envelope catchall accepts JSON with empty-string values', () => {
  beforeEach(resetEnvAndConfig)
  afterEach(async () => {
    restoreEnvelopeEnv()
    await deleteConfig()
  })

  test('config.json with an operator key holding an empty string survives schema parse', async () => {
    // Regression: the disk envelope catchall used JsonPrimitiveSchema
    // which required strings be nonempty. A nested "" anywhere in a key
    // the schema does not declare would blow up the entire config read
    // and get the file wiped.
    await writeConfig(
      JSON.stringify({
        PORT: 3456,
        LOG: false,
        LOG_LEVEL: 'info',
        APIKEY: 'k',
        OperatorNotes: {
          entries: [{ label: '', body: 'kept for later', tags: [] }]
        }
      })
    )
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBe('k')
    // Config was NOT wiped: the original PORT survived.
    expect(cfg.PORT).toBe(3456)
  })
})

describe('applyEnvelopeToEnv', () => {
  test('mirrors string scalar keys onto process.env', () => {
    applyEnvelopeToEnv({ HOST: '127.0.0.1', APIKEY: 'key123' })
    expect(process.env.HOST).toBe('127.0.0.1')
    expect(process.env.APIKEY).toBe('key123')
  })

  test('coerces number and boolean to string', () => {
    applyEnvelopeToEnv({ PORT: 3456, LOG: true })
    expect(process.env.PORT).toBe('3456')
    expect(process.env.LOG).toBe('true')
  })

  test('skips null and undefined values', () => {
    delete process.env.PROXY_URL
    applyEnvelopeToEnv({ PROXY_URL: null })
    expect(process.env.PROXY_URL).toBeUndefined()
  })

  test('skips object and array values', () => {
    const before = process.env.StatusLine
    applyEnvelopeToEnv({ StatusLine: { enabled: true } } as Record<string, unknown>)
    expect(process.env.StatusLine).toBe(before)
  })
})

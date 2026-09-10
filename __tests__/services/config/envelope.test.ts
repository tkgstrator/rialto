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
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info' }))
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
    }`)
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(3456)
    expect(cfg.LOG).toBe(true)
  })

  test('interpolates $VAR_NAME', async () => {
    process.env.TEST_RIALTO_PROXY = 'http://proxy.internal:3128'
    await writeConfig(JSON.stringify({ LOG: false, LOG_LEVEL: 'info', PROXY_URL: '$TEST_RIALTO_PROXY' }))
    const cfg = await readConfigFile()
    expect(cfg.PROXY_URL).toBe('http://proxy.internal:3128')
    delete process.env.TEST_RIALTO_PROXY
  })

  test('interpolates ${VAR_NAME}', async () => {
    process.env.TEST_RIALTO_HOST = '0.0.0.0'
    await writeConfig(JSON.stringify({ HOST: '${TEST_RIALTO_HOST}', LOG: false, LOG_LEVEL: 'info' }))
    const cfg = await readConfigFile()
    expect(cfg.HOST).toBe('0.0.0.0')
    delete process.env.TEST_RIALTO_HOST
  })

  test('keeps literal when env var is unset', async () => {
    delete process.env.UNSET_RIALTO_VAR
    await writeConfig(JSON.stringify({ LOG: false, LOG_LEVEL: 'info', PROXY_URL: '$UNSET_RIALTO_VAR' }))
    const cfg = await readConfigFile()
    expect(cfg.PROXY_URL).toBe('$UNSET_RIALTO_VAR')
  })

  test('interpolates env vars inside nested objects and arrays', async () => {
    process.env.TEST_RIALTO_BASE = 'https://api.example.com'
    await writeConfig(
      JSON.stringify({
        LOG: false,
        LOG_LEVEL: 'info',
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

  test('a fresh config carries no credential', async () => {
    // It used to mint an APIKEY: a master key for /api/* on every install.
    const cfg = await readConfigFile()
    expect(cfg.APIKEY).toBeUndefined()
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
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'debug', API_TIMEOUT_MS: '30000' }))
    const cfg = await readConfigFile()
    // readConfigFile returns the schema-parsed envelope, so API_TIMEOUT_MS
    // is coerced to a number. The important guarantee is that the file does
    // NOT fall back to createDefaultConfig() — LOG_LEVEL is preserved.
    expect(cfg.LOG_LEVEL).toBe('debug')
    expect(cfg.PORT).toBe(3456)
    expect(cfg.API_TIMEOUT_MS).toBe(30000)
  })

  test('number API_TIMEOUT_MS is accepted and returned as-is', async () => {
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', API_TIMEOUT_MS: 30000 }))
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBe(30000)
  })

  test('absent API_TIMEOUT_MS is valid (field is optional)', async () => {
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'debug' }))
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBeUndefined()
    // Config was NOT recreated — original settings are preserved.
    expect(cfg.LOG_LEVEL).toBe('debug')
  })

  // These two used to assert that a rejected config "is lost, but a new
  // one is generated". The file is moved aside rather than deleted now,
  // and the persona library — stored nowhere else — is carried into the
  // rebuilt one.
  test('a negative API_TIMEOUT_MS is dropped without taking the persona library with it', async () => {
    const personas = [{ id: 'p1', name: 'Mine', prompt: 'hello' }]
    await writeConfig(
      JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', API_TIMEOUT_MS: -1, Personas: personas })
    )
    const cfg = await readConfigFile()
    expect(cfg.API_TIMEOUT_MS).toBeUndefined()
    expect(cfg.Personas).toEqual(personas)
  })

  test('a non-numeric API_TIMEOUT_MS is dropped without taking the persona library with it', async () => {
    const personas = [{ id: 'p1', name: 'Mine', prompt: 'hello' }]
    await writeConfig(
      JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', API_TIMEOUT_MS: 'fast', Personas: personas })
    )
    const cfg = await readConfigFile()
    expect(cfg.Personas).toEqual(personas)
  })

  test('"600000" (old UI default value as string) does not destroy config', async () => {
    await writeConfig(
      JSON.stringify({
        PORT: 3456,
        LOG: true,
        LOG_LEVEL: 'debug',
        HOST: '0.0.0.0',
        API_TIMEOUT_MS: '600000'
      })
    )
    const cfg = await readConfigFile()
    expect(cfg.HOST).toBe('0.0.0.0')
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

  test('process.env value overrides the disk envelope', async () => {
    process.env.HOST = '0.0.0.0'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', HOST: '127.0.0.1' }))
    const cfg = await readConfigFile()
    expect(cfg.HOST).toBe('0.0.0.0')
  })

  test('empty-string env value does NOT override the disk envelope', async () => {
    // A stray `ACCESS_AUD=` in a .env file must not blank the value on
    // disk — for the Access pair, that would silently turn it off.
    process.env.ACCESS_AUD = ''
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info', ACCESS_AUD: 'from-disk' }))
    const cfg = await readConfigFile()
    expect(cfg.ACCESS_AUD).toBe('from-disk')
  })

  test('numeric envelope keys from env are coerced to numbers before schema parse', async () => {
    process.env.PORT = '9999'
    process.env.API_TIMEOUT_MS = '15000'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info' }))
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(9999)
    expect(cfg.API_TIMEOUT_MS).toBe(15000)
  })

  test('boolean envelope keys accept "true" / "1" from env', async () => {
    process.env.LOG = 'true'
    process.env.NON_INTERACTIVE_MODE = '1'
    await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info' }))
    const cfg = await readConfigFile()
    expect(cfg.LOG).toBe(true)
    expect(cfg.NON_INTERACTIVE_MODE).toBe(true)
  })

  test('env wins over the default config written for a fresh container', async () => {
    // No config file on disk. The default-config path writes PORT 3456;
    // the deploy's environment still decides the returned runtime value.
    process.env.PORT = '4000'
    const cfg = await readConfigFile()
    expect(cfg.PORT).toBe(4000)
  })

  test('an APIKEY in the environment is not overlaid — the key is retired', async () => {
    // A compose file written for an older build may still pass one.
    // Nothing reads it, so it must not reappear on the envelope either.
    process.env.APIKEY = 'from-an-old-compose-file'
    try {
      await writeConfig(JSON.stringify({ PORT: 3456, LOG: false, LOG_LEVEL: 'info' }))
      const cfg = await readConfigFile()
      expect(cfg.APIKEY).toBeUndefined()
    } finally {
      delete process.env.APIKEY
    }
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
        LOG_LEVEL: 'debug',
        OperatorNotes: {
          entries: [{ label: '', body: 'kept for later', tags: [] }]
        }
      })
    )
    const cfg = await readConfigFile()
    expect(cfg.LOG_LEVEL).toBe('debug')
    // Config was NOT wiped: the original PORT survived.
    expect(cfg.PORT).toBe(3456)
  })
})

describe('applyEnvelopeToEnv', () => {
  afterEach(restoreEnvelopeEnv)

  test('mirrors string scalar keys onto process.env', () => {
    applyEnvelopeToEnv({ HOST: '127.0.0.1', ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' })
    expect(process.env.HOST).toBe('127.0.0.1')
    expect(process.env.ACCESS_TEAM_DOMAIN).toBe('team.cloudflareaccess.com')
  })

  test('does not mirror a retired APIKEY left on disk', () => {
    delete process.env.APIKEY
    applyEnvelopeToEnv({ APIKEY: 'left-on-disk' })
    expect(process.env.APIKEY).toBeUndefined()
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

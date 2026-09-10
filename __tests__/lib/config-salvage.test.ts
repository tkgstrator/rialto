/**
 * A config file that fails to load must not be destroyed.
 *
 * Regression coverage for a real incident: `readConfigFile` responded to
 * a schema-validation failure by unlinking the operator's config and
 * generating a fresh one — which replaced the admin credential of the day
 * and locked out every configured client. There are no backups, so the
 * file was the only copy, and a single bad key (including one arriving
 * from a stray environment variable) was enough to trigger it.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readConfigFile } from '../../src/services/config/envelope'
import { CONFIG_FILE } from '../../src/shared/constants'
import { ENVELOPE_ENV_KEYS } from '../../src/shared/db/types'

// Operate on whatever home the module actually resolved. CONFIG_FILE is
// computed once, when shared/constants.ts is first imported, so in a
// full-suite run the winning value belongs to whichever test file
// imported it first — the preload's tmp home. Deriving the directory
// from CONFIG_FILE keeps this file correct either way instead of
// depending on import order.
const HOME = dirname(CONFIG_FILE)
const KEY = 'a'.repeat(64)
const asides = (): string[] => readdirSync(HOME).filter((n) => n.includes('.invalid-'))

// The env overlay outranks the file, and an earlier suite in the same
// process can leave envelope scalars behind. A PORT left there would
// replace the file's deliberately invalid one, the file would validate,
// and the quarantine these tests check for would never run.
async function readWithoutEnv() {
  const saved = new Map(ENVELOPE_ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENVELOPE_ENV_KEYS) delete process.env[key]
  try {
    return await readConfigFile()
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value
    }
  }
}

beforeEach(() => {
  mkdirSync(HOME, { recursive: true })
  for (const name of readdirSync(HOME)) rmSync(join(HOME, name), { recursive: true, force: true })
})

describe('readConfigFile — unusable config', () => {
  test('keeps the persona library, which is stored nowhere else', async () => {
    // PORT must be a positive int; a non-numeric string fails the schema.
    const personas = [{ id: 'p1', name: 'Mine', prompt: 'hello' }]
    writeFileSync(CONFIG_FILE, JSON.stringify({ PORT: 'not-a-port', Personas: personas }))
    const envelope = await readWithoutEnv()
    expect(envelope.Personas).toEqual(personas)
  })

  test('moves the unusable file aside instead of deleting it', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ PORT: 'bad', LOG_LEVEL: 'debug' }))
    await readWithoutEnv()
    const moved = asides()
    expect(moved).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(HOME, moved[0]), 'utf-8')).LOG_LEVEL).toBe('debug')
  })

  test('still writes a usable config so the server can boot', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ PORT: 'bad' }))
    const envelope = await readWithoutEnv()
    expect(existsSync(CONFIG_FILE)).toBe(true)
    expect(envelope.PORT).toBe(3456)
  })

  test('carries no credential into the rebuilt config', async () => {
    // A retired APIKEY is not salvaged. Nothing reads it, and copying a
    // plaintext secret into a fresh file would only spread it; the
    // original is still in the file moved aside.
    writeFileSync(CONFIG_FILE, JSON.stringify({ APIKEY: KEY, PORT: 'bad' }))
    const envelope = await readWithoutEnv()
    expect(envelope.APIKEY).toBeUndefined()
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')).APIKEY).toBeUndefined()
  })

  test('preserves a file JSON5 cannot read, even though nothing is salvageable from it', async () => {
    writeFileSync(CONFIG_FILE, '{ this is not json at all ')
    await readWithoutEnv()
    expect(asides()).toHaveLength(1)
  })
})

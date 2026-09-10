/**
 * The home-directory migration.
 *
 * This is the one step of the Rialto rename that can destroy an
 * operator's configuration, so the cases here are mostly about what it
 * must NOT do: overwrite an existing home, remove the original before
 * the copy has been verified, or leave a partial copy that the next
 * boot mistakes for a finished one.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, migrateHomeDir } from '../../../src/services/config/migrate-home-dir'

const roots: string[] = []

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rialto-home-'))
  roots.push(root)
  return root
}

function seedLegacy(root: string): string {
  const legacy = join(root, LEGACY_HOME_DIR_NAME)
  mkdirSync(join(legacy, 'logs'), { recursive: true })
  writeFileSync(join(legacy, 'config.json'), JSON.stringify({ PORT: 3456, LOG_LEVEL: 'debug' }))
  writeFileSync(join(legacy, 'logs', 'ccr-2026-08-31.log'), 'line\n')
  return legacy
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('migrateHomeDir', () => {
  test('copies the legacy directory, contents and all', async () => {
    const root = newRoot()
    seedLegacy(root)

    const result = await migrateHomeDir(root)

    expect(result.outcome).toBe('moved')
    expect(result.fileCount).toBe(2)
    const moved = JSON.parse(readFileSync(join(root, HOME_DIR_NAME, 'config.json'), 'utf-8'))
    expect(moved.LOG_LEVEL).toBe('debug')
    expect(existsSync(join(root, HOME_DIR_NAME, 'logs', 'ccr-2026-08-31.log'))).toBe(true)
  })

  test('removes the original once the copy verifies', async () => {
    const root = newRoot()
    const legacy = seedLegacy(root)

    const result = await migrateHomeDir(root)

    expect(result.legacyRemoved).toBe(true)
    expect(existsSync(legacy)).toBe(false)
  })

  test('does nothing when the new home already exists', async () => {
    const root = newRoot()
    seedLegacy(root)
    mkdirSync(join(root, HOME_DIR_NAME))
    writeFileSync(join(root, HOME_DIR_NAME, 'config.json'), JSON.stringify({ LOG_LEVEL: 'warn' }))

    const result = await migrateHomeDir(root)

    expect(result.outcome).toBe('already-migrated')
    // The live config must survive: overwriting it with an older copy
    // would be the migration destroying the thing it exists to preserve.
    expect(JSON.parse(readFileSync(join(root, HOME_DIR_NAME, 'config.json'), 'utf-8')).LOG_LEVEL).toBe('warn')
  })

  test('is idempotent — running twice changes nothing the second time', async () => {
    const root = newRoot()
    seedLegacy(root)

    const first = await migrateHomeDir(root)
    const second = await migrateHomeDir(root)

    expect(first.outcome).toBe('moved')
    expect(second.outcome).toBe('already-migrated')
    expect(second.fileCount).toBe(0)
  })

  test('reports nothing to do on a fresh install', async () => {
    const result = await migrateHomeDir(newRoot())
    expect(result.outcome).toBe('nothing-to-migrate')
    expect(result.fileCount).toBe(0)
  })

  test('removes a partial copy rather than leaving one the next boot would accept', async () => {
    const root = newRoot()
    const legacy = seedLegacy(root)
    // An unreadable subdirectory fails the copy midway.
    const locked = join(legacy, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'secret.json'), '{}')
    chmodSync(locked, 0o000)

    const result = await migrateHomeDir(root)
    chmodSync(locked, 0o755)

    expect(result.outcome).toBe('failed')
    // The half-copy is gone, so the next boot retries instead of running
    // on a fraction of the operator's configuration.
    expect(existsSync(join(root, HOME_DIR_NAME))).toBe(false)
    // And nothing was removed: the original is the only copy that exists
    // at this point, so deleting before verifying would lose it outright.
    expect(existsSync(join(legacy, 'config.json'))).toBe(true)
    expect(result.legacyRemoved).toBe(false)
  })

  test('never throws — a failed migration must not stop the server booting', async () => {
    const root = newRoot()
    const legacy = seedLegacy(root)
    chmodSync(legacy, 0o000)

    const result = await migrateHomeDir(root)
    chmodSync(legacy, 0o755)

    expect(result.outcome).toBe('failed')
  })
})

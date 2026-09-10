/**
 * LOG_MAX_MB is edited from Settings → Logging and read by the logger from
 * process.env. It used to be neither declared on the envelope nor mirrored
 * onto process.env, so a save reached the disk and never the logger.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ConfigEnvelopeSchema } from '../../../src/schemas/domain/config'
import { applyEnvelopeToEnv } from '../../../src/services/config/envelope'
import { ENVELOPE_ENV_KEYS } from '../../../src/shared/db/types'

// applyEnvelopeToEnv deletes every envelope key the payload lacks, so put
// the process's own values back for whatever runs after this file.
const saved = new Map<string, string | undefined>()

describe('LOG_MAX_MB on the envelope', () => {
  beforeEach(() => {
    for (const key of ENVELOPE_ENV_KEYS) saved.set(key, process.env[key])
  })

  afterEach(() => {
    for (const key of ENVELOPE_ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('is declared, so the envelope keeps it as a number', () => {
    const logMaxMbOf = (input: Record<string, unknown>): number | undefined | 'invalid' => {
      const result = ConfigEnvelopeSchema.safeParse(input)
      return result.success ? result.data.LOG_MAX_MB : 'invalid'
    }
    expect(logMaxMbOf({ LOG_MAX_MB: 25 })).toBe(25)
    expect(logMaxMbOf({ LOG_MAX_MB: '25' })).toBe(25)
    expect(logMaxMbOf({})).toBeUndefined()
  })

  test('is mirrored onto process.env, where the logger reads it', () => {
    applyEnvelopeToEnv({ LOG_MAX_MB: 25 })
    expect(process.env.LOG_MAX_MB).toBe('25')
  })

  test('is removed from process.env once the envelope no longer carries it', () => {
    process.env.LOG_MAX_MB = '25'
    applyEnvelopeToEnv({})
    expect(process.env.LOG_MAX_MB).toBeUndefined()
  })
})

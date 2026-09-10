import { describe, expect, test } from 'bun:test'
import {
  captureSettings,
  fmtBytes,
  formatJson,
  isValidJson,
  lineNumbers,
  orUnset,
  parseCount,
  totalBytes
} from '../../../../src/lib/rialto/settings/envelope'

describe('orUnset', () => {
  test('passes a present value through', () => {
    expect(orUnset('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  test('collapses null, undefined and empty string to the same word', () => {
    expect(orUnset(null)).toBe('unset')
    expect(orUnset(undefined)).toBe('unset')
    expect(orUnset('')).toBe('unset')
  })
})

describe('fmtBytes', () => {
  test('keeps one decimal below ten and drops it above', () => {
    expect(fmtBytes(9.4 * 1024 * 1024)).toBe('9.4 MB')
    expect(fmtBytes(186 * 1024 * 1024)).toBe('186 MB')
    expect(fmtBytes(1.8 * 1024 * 1024 * 1024)).toBe('1.8 GB')
  })

  test('reports raw bytes below a kilobyte', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
  })

  test('steps up a unit exactly at the boundary', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB')
  })
})

describe('totalBytes', () => {
  test('totals the archive stores', () => {
    expect(totalBytes([{ bytes: 100 }, { bytes: 250 }, { bytes: 1 }])).toBe(351)
  })

  test('an empty store list totals zero', () => {
    expect(totalBytes([])).toBe(0)
  })
})

describe('parseCount', () => {
  test('accepts a non-negative integer', () => {
    expect(parseCount('600000')).toBe(600000)
    expect(parseCount(' 10 ')).toBe(10)
    expect(parseCount('0')).toBe(0)
  })

  test('refuses anything that would write NaN or a fraction to disk', () => {
    expect(parseCount('')).toBeNull()
    expect(parseCount('abc')).toBeNull()
    expect(parseCount('-1')).toBeNull()
    expect(parseCount('1.5')).toBeNull()
  })
})

describe('isValidJson / formatJson', () => {
  test('reports a parseable document as valid and pretty-prints it', () => {
    expect(isValidJson('{"a":1}')).toBe(true)
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  test('reports a broken document without throwing', () => {
    expect(isValidJson('{"a":')).toBe(false)
    expect(formatJson('{"a":')).toBeNull()
  })
})

describe('lineNumbers', () => {
  test('numbers every line including a trailing empty one', () => {
    expect(lineNumbers('a\nb')).toEqual([1, 2])
    expect(lineNumbers('a\n')).toEqual([1, 2])
    expect(lineNumbers('')).toEqual([1])
  })
})

describe('captureSettings', () => {
  test('an envelope with no capture keys is still recording', () => {
    // Both capture keys default ON server-side. Reading an absent key as
    // false would have the screen report capture disabled on an install
    // that is recording normally.
    expect(captureSettings({})).toEqual({
      CAPTURE_REQUESTS: true,
      CAPTURE_MESSAGES: true,
      REDACT_TOOL_ARGUMENTS: false
    })
  })

  test('only an explicit false turns capture off', () => {
    expect(captureSettings({ CAPTURE_REQUESTS: false }).CAPTURE_REQUESTS).toBe(false)
    expect(captureSettings({ CAPTURE_MESSAGES: false }).CAPTURE_MESSAGES).toBe(false)
    expect(captureSettings({ CAPTURE_REQUESTS: true }).CAPTURE_REQUESTS).toBe(true)
  })

  test('redaction stays off unless explicitly enabled', () => {
    // It destroys tool arguments irreversibly, so absent must never
    // resolve to on.
    expect(captureSettings({}).REDACT_TOOL_ARGUMENTS).toBe(false)
    expect(captureSettings({ REDACT_TOOL_ARGUMENTS: true }).REDACT_TOOL_ARGUMENTS).toBe(true)
  })
})

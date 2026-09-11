import { describe, expect, test } from 'bun:test'
import { colorHex, moduleMeta, moveModule, previewText } from '../../../../src/lib/rialto/settings-content/statusline'
import type { StatusLineModuleConfig } from '../../../../src/types'

const module = (over: Partial<StatusLineModuleConfig> = {}): StatusLineModuleConfig => ({
  type: 'model',
  icon: '󰚩',
  text: '{{model}}',
  color: 'bright_cyan',
  ...over
})

describe('moduleMeta', () => {
  test('returns the palette entry for a known type', () => {
    // A key, not a label: the palette used to carry English display text,
    // which reached the JA build untranslated.
    expect(moduleMeta('gitBranch').labelKey).toBe('settings.statusline.moduleGitBranch')
  })

  test('falls back rather than crashing on a hand-written type', () => {
    const meta = moduleMeta('somethingElse')
    expect(meta.type).toBe('somethingElse')
    expect(meta.icon).not.toBe('')
  })
})

describe('previewText', () => {
  test('substitutes the preview variables and prefixes the icon', () => {
    expect(previewText(module())).toBe('󰚩 claude-opus-4-8')
  })

  test('substitutes tokenSpeed, which the legacy preview map omits', () => {
    expect(previewText(module({ type: 'speed', icon: '', text: '{{tokenSpeed}} t/s' }))).toBe('48 t/s')
  })

  test('omits the leading space when the module has no icon', () => {
    expect(previewText(module({ icon: undefined, text: '{{gitBranch}}' }))).toBe('main')
  })

  test('strips the provider prefix by default', () => {
    expect(previewText(module())).toBe('󰚩 claude-opus-4-8')
  })

  test('keeps the provider prefix when keepProvider is set', () => {
    expect(previewText(module({ keepProvider: true }))).toBe('󰚩 claude-code,claude-opus-4-8')
  })

  test('ignores keepProvider on a non-model module', () => {
    expect(previewText(module({ type: 'gitBranch', icon: undefined, text: '{{gitBranch}}', keepProvider: true }))).toBe(
      'main'
    )
  })

  test('appends the separator after the module text', () => {
    expect(previewText(module({ separator: ' | ' }))).toBe('󰚩 claude-opus-4-8 | ')
  })
})

describe('colorHex', () => {
  test('resolves an ANSI name', () => {
    expect(colorHex('bright_blue')).toBe('#5c5cff')
  })

  test('passes a literal hex through', () => {
    expect(colorHex('#38BDF8')).toBe('#38BDF8')
  })

  test('returns null for an unset or unknown colour', () => {
    expect(colorHex(undefined)).toBeNull()
    expect(colorHex('')).toBeNull()
    expect(colorHex('chartreuse')).toBeNull()
  })
})

describe('moveModule', () => {
  const line = [module({ type: 'workDir' }), module({ type: 'gitBranch' }), module({ type: 'model' })]

  test('moves a module later in the line', () => {
    expect(moveModule(line, 0, 2).map((m) => m.type)).toEqual(['gitBranch', 'model', 'workDir'])
  })

  test('moves a module earlier in the line', () => {
    expect(moveModule(line, 2, 0).map((m) => m.type)).toEqual(['model', 'workDir', 'gitBranch'])
  })

  test('returns the line untouched for an out-of-range index', () => {
    expect(moveModule(line, 0, 9)).toBe(line)
    expect(moveModule(line, 9, 0)).toBe(line)
  })
})

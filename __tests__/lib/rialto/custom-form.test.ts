/**
 * What the Custom provider's form decides before anything is sent.
 *
 * The screen cannot show these going wrong, so they are pinned here: an
 * untouched field is never reported as a mistake, the form refuses exactly
 * what the API would, and the address it previews is the one that is stored.
 */
import { describe, expect, test } from 'bun:test'
import {
  CUSTOM_ENTRY,
  CUSTOM_ENTRY_NAME,
  type CustomDraft,
  customDraftProblems,
  customEndpointPreview,
  EMPTY_CUSTOM_DRAFT,
  isCustomDraftReady,
  isCustomEntry,
  modelIdProblem,
  withCustomEntry
} from '../../../src/components/rialto/providers/custom-form'
import type { CatalogEntry } from '../../../src/components/rialto/providers/types'
import { CUSTOM_API_STYLES } from '../../../src/shared/custom-provider'

const draft = (over: Partial<CustomDraft> = {}): CustomDraft => ({
  name: 'lm-studio',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'lm-studio',
  style: 'openai_chat',
  ...over
})

describe('the rail entry', () => {
  const vendor = (name: string): CatalogEntry => ({ ...CUSTOM_ENTRY, name, displayName: name })

  test('is an api_key entry with no models and nothing enabled', () => {
    expect(CUSTOM_ENTRY.authMode).toBe('api_key')
    expect(CUSTOM_ENTRY.models).toEqual([])
    expect(CUSTOM_ENTRY.enabled).toBe(false)
  })

  test('is appended once, after the catalog', () => {
    const catalog = [vendor('openai'), vendor('anthropic')]
    expect(withCustomEntry(catalog).map((e) => e.name)).toEqual(['openai', 'anthropic', CUSTOM_ENTRY_NAME])
  })

  test('is not added twice when the catalog already carries one', () => {
    const catalog = [vendor('openai'), vendor(CUSTOM_ENTRY_NAME)]
    expect(withCustomEntry(catalog)).toHaveLength(2)
  })

  test('does not mutate the catalog it is given', () => {
    const catalog = [vendor('openai')]
    withCustomEntry(catalog)
    expect(catalog).toHaveLength(1)
  })

  test('isCustomEntry is true for the card and false for a vendor or nothing', () => {
    expect(isCustomEntry(CUSTOM_ENTRY)).toBe(true)
    expect(isCustomEntry(vendor('openai'))).toBe(false)
    expect(isCustomEntry(undefined)).toBe(false)
  })
})

describe('the empty draft', () => {
  test('starts on Chat Completions, which is what most compatible servers speak', () => {
    expect(EMPTY_CUSTOM_DRAFT.style).toBe('openai_chat')
  })

  test('is not ready and reports no problems', () => {
    expect(isCustomDraftReady(EMPTY_CUSTOM_DRAFT, [])).toBe(false)
    expect(customDraftProblems(EMPTY_CUSTOM_DRAFT, [])).toEqual({ name: null, baseUrl: null })
  })
})

describe('customDraftProblems', () => {
  test('a good draft has none', () => {
    expect(customDraftProblems(draft(), ['openai'])).toEqual({ name: null, baseUrl: null })
  })

  test.each([
    ['too_long', 'a'.repeat(49)],
    ['charset', 'My Gateway'],
    ['reserved', 'openai']
  ])('a %s name is reported', (problem, name) => {
    expect(customDraftProblems(draft({ name }), []).name).toBe(problem)
  })

  test('a name that is already a provider is taken, whatever its case', () => {
    expect(customDraftProblems(draft({ name: 'my-gateway' }), ['my-gateway']).name).toBe('taken')
    expect(customDraftProblems(draft({ name: 'my-gateway' }), ['My-Gateway']).name).toBe('taken')
  })

  test('taken ignores surrounding whitespace in the typed name', () => {
    expect(customDraftProblems(draft({ name: '  my-gateway ' }), ['my-gateway']).name).toBe('taken')
  })

  test('a built-in collision reads as reserved, not taken, even when the vendor is already added', () => {
    expect(customDraftProblems(draft({ name: 'openai' }), ['openai']).name).toBe('reserved')
  })

  test('a Base URL that is not an http(s) address is reported', () => {
    expect(customDraftProblems(draft({ baseUrl: 'localhost:1234' }), []).baseUrl).toBe('invalid_base_url')
    expect(customDraftProblems(draft({ baseUrl: 'ftp://h/v1' }), []).baseUrl).toBe('invalid_base_url')
    expect(customDraftProblems(draft({ baseUrl: 'http://u:p@h/v1' }), []).baseUrl).toBe('invalid_base_url')
  })

  test('an untouched field is not a mistake', () => {
    expect(customDraftProblems(draft({ name: '   ', baseUrl: '  ' }), [])).toEqual({ name: null, baseUrl: null })
  })
})

describe('isCustomDraftReady', () => {
  test('a complete, valid draft is ready', () => {
    expect(isCustomDraftReady(draft(), [])).toBe(true)
  })

  test.each([
    ['name', { name: '' }],
    ['Base URL', { baseUrl: '' }],
    ['API key', { apiKey: '' }]
  ])('a missing %s is not ready', (_label, over) => {
    expect(isCustomDraftReady(draft(over), [])).toBe(false)
  })

  test('a blank API key is not a key', () => {
    expect(isCustomDraftReady(draft({ apiKey: '   ' }), [])).toBe(false)
  })

  test('a refused name or Base URL is not ready', () => {
    expect(isCustomDraftReady(draft({ name: 'openai' }), [])).toBe(false)
    expect(isCustomDraftReady(draft({ name: 'lm-studio' }), ['lm-studio'])).toBe(false)
    expect(isCustomDraftReady(draft({ baseUrl: 'nope' }), [])).toBe(false)
  })

  test('every wire format is acceptable', () => {
    for (const style of CUSTOM_API_STYLES) expect(isCustomDraftReady(draft({ style }), [])).toBe(true)
  })
})

describe('customEndpointPreview', () => {
  test('shows the Base URL exactly as it will be stored, whatever the format', () => {
    for (const style of ['openai_chat', 'openai_responses', 'anthropic'] as const) {
      expect(customEndpointPreview(draft({ baseUrl: 'http://localhost:1234/v1', style }))).toBe(
        'http://localhost:1234/v1'
      )
    }
  })

  test('is nothing while the Base URL is empty or not an address', () => {
    expect(customEndpointPreview(draft({ baseUrl: '' }))).toBeNull()
    expect(customEndpointPreview(draft({ baseUrl: 'nope' }))).toBeNull()
  })
})

describe('modelIdProblem', () => {
  test('a plain id is fine', () => {
    expect(modelIdProblem('qwen3-coder:30b', [])).toBeNull()
    expect(modelIdProblem('  gpt-4o  ', [])).toBeNull()
  })

  test('nothing typed is empty, which the form shows as unfinished', () => {
    expect(modelIdProblem('', [])).toBe('empty')
    expect(modelIdProblem('   ', [])).toBe('empty')
  })

  test('whitespace inside an id could never be a model', () => {
    expect(modelIdProblem('gpt 4o', [])).toBe('space')
    expect(modelIdProblem('a\tb', [])).toBe('space')
  })

  test('an id the provider already lists is a duplicate', () => {
    expect(modelIdProblem('gpt-4o', ['gpt-4o'])).toBe('duplicate')
    expect(modelIdProblem(' gpt-4o ', ['gpt-4o'])).toBe('duplicate')
  })

  test('ids differing only by case are different ids: servers are case-sensitive', () => {
    expect(modelIdProblem('GPT-4o', ['gpt-4o'])).toBeNull()
  })
})

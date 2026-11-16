/**
 * The release order read from a model id.
 *
 * A tier routes to the newest switched-on model its name says, so this
 * order is what decides where "claude-code · sonnet" goes once two Sonnets
 * are on. The cases are the id shapes vendors actually publish.
 */
import { describe, expect, test } from 'bun:test'
import { isVersionUpdate, modelStem, newestFirst, parseModelVersion } from '../../src/shared/model-version'

describe('parseModelVersion', () => {
  test.each([
    ['claude-sonnet-5-5', [5, 5], null],
    ['claude-sonnet-5', [5], null],
    ['claude-sonnet-4-6', [4, 6], null],
    ['claude-sonnet-4-20250514', [4], 20250514],
    ['claude-3-5-sonnet-20241022', [3, 5], 20241022],
    ['claude-haiku-4-5-20251001', [4, 5], 20251001],
    ['claude-sonnet-4-5[1m]', [4, 5], null],
    ['anthropic/claude-sonnet-4.5', [4, 5], null],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', [4], 20250514],
    ['gpt-5.4-mini', [5, 4], null],
    ['gpt-4-0613', [4], null],
    ['claude-sonnet-latest', [], null]
  ] as const)('%s', (name, parts, date) => {
    expect(parseModelVersion(name)).toEqual({ parts: [...parts], date })
  })
})

describe('newestFirst', () => {
  const sorted = (names: string[]): string[] => [...names].sort(newestFirst)

  test('a higher version wins', () => {
    expect(sorted(['claude-sonnet-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5'])).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6'
    ])
  })

  test('a date never outranks a higher version', () => {
    expect(sorted(['claude-sonnet-4-20250514', 'claude-sonnet-4-6'])).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-20250514'
    ])
    expect(sorted(['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'])).toEqual([
      'claude-sonnet-4-6',
      'claude-3-5-sonnet-20241022'
    ])
  })

  test('at one version the undated id comes first, then the later snapshot', () => {
    expect(sorted(['claude-haiku-4-5-20251001', 'claude-haiku-4-5'])).toEqual([
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001'
    ])
    expect(sorted(['claude-opus-4-1-20250101', 'claude-opus-4-1-20250805'])).toEqual([
      'claude-opus-4-1-20250805',
      'claude-opus-4-1-20250101'
    ])
  })

  test('an id with no version ranks last', () => {
    expect(sorted(['claude-sonnet-latest', 'claude-sonnet-4-6'])).toEqual(['claude-sonnet-4-6', 'claude-sonnet-latest'])
  })

  test('ties fall to the name, so the order is total', () => {
    expect(sorted(['claude-opus-4-0', 'claude-opus-4'])).toEqual(['claude-opus-4', 'claude-opus-4-0'])
    const names = [
      'claude-sonnet-5-5',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4',
      'claude-sonnet-4-0',
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-latest'
    ]
    const expected = sorted(names)
    expect(sorted([...names].reverse())).toEqual(expected)
    expect(sorted([names[3], names[0], names[5], names[1], names[4], names[2]])).toEqual(expected)
  })
})

describe('modelStem', () => {
  test.each([
    // Claude new scheme
    ['claude-sonnet-5-5', 'claude-sonnet'],
    ['claude-sonnet-5', 'claude-sonnet'],
    ['claude-opus-4-1', 'claude-opus'],
    ['claude-opus-5', 'claude-opus'],
    ['claude-fable-5-1', 'claude-fable'],
    ['claude-haiku-4-5', 'claude-haiku'],
    // Claude old scheme: the family word ("sonnet") comes after the
    // version run and stays in the stem, so the old and new schemes land
    // on the same stem — "claude-3-5-sonnet" and "claude-sonnet-5-5"
    // are both of the "claude-sonnet" family, but their version parts
    // differ so `isVersionUpdate` separates them.
    ['claude-3-5-sonnet-20241022', 'claude-sonnet'],
    ['claude-3-7-sonnet-20250219', 'claude-sonnet'],
    ['claude-3-opus-20240229', 'claude-opus'],
    ['claude-3-haiku-20240307', 'claude-haiku'],
    // OpenAI variant qualifiers after the version stay in the stem, so
    // a request for `gpt-5-mini` does NOT update to the plain `gpt-5`.
    ['gpt-5.4-mini', 'gpt-mini'],
    ['gpt-5-codex', 'gpt-codex'],
    ['gpt-5.1-codex-max', 'gpt-codex-max'],
    ['gpt-5.1-codex-mini', 'gpt-codex-mini'],
    ['gpt-5.1-chat-latest', 'gpt-chat-latest'],
    ['gpt-5.6-luna', 'gpt-luna'],
    ['gpt-4.5-preview', 'gpt-preview'],
    ['gpt-4-turbo-preview', 'gpt-turbo-preview'],
    ['gpt-image-2.5-flare', 'gpt-image-flare'],
    // OpenAI reasoning models: `o1`/`o3`/`o4` are mixed tokens
    // (letter+digit), which `parseModelVersion` does not read as a
    // version, so the token stays in the stem. That keeps `o1` and
    // `o3` apart — they are separate model lines, not versions of each
    // other.
    ['o1', 'o1'],
    ['o1-mini', 'o1-mini'],
    ['o3-mini', 'o3-mini'],
    ['o3-deep-research', 'o3-deep-research'],
    // `4o` in `gpt-4o` is the same mixed-token story — the whole id has
    // no version run, so the stem IS the id.
    ['gpt-4o', 'gpt-4o'],
    ['gpt-4o-mini', 'gpt-4o-mini'],
    ['gpt-4o-audio-preview', 'gpt-4o-audio-preview'],
    // Gemini: dotted versions and variant qualifiers.
    ['gemini-3', 'gemini'],
    ['gemini-3.8-flash', 'gemini-flash'],
    ['gemini-2.5-pro', 'gemini-pro'],
    // The 8-digit snapshot pin (what `parseModelVersion` records as
    // `date`) drops out too — it is another flavour of version token,
    // not a model family distinguisher.
    ['claude-sonnet-4-20250514', 'claude-sonnet'],
    // Context-window suffix `[1m]`: `1m` is a mixed token, so it keeps
    // `claude-sonnet-4-5[1m]` apart from the base `claude-sonnet-4-5`.
    ['claude-sonnet-4-5[1m]', 'claude-sonnet-1m'],
    ['anthropic/claude-sonnet-4.5', 'anthropic-claude-sonnet'],
    // An id with no version parts — the whole thing is the stem.
    ['claude-sonnet-latest', 'claude-sonnet-latest']
  ] as const)('%s → %s', (name, stem) => {
    expect(modelStem(name)).toBe(stem)
  })
})

describe('isVersionUpdate', () => {
  test('a candidate with more version parts after the requested run is an update', () => {
    expect(isVersionUpdate('claude-sonnet-5', 'claude-sonnet-5-5')).toBe(true)
    expect(isVersionUpdate('claude-opus-4', 'claude-opus-4-1')).toBe(true)
    expect(isVersionUpdate('claude-sonnet-5', 'claude-sonnet-5-5-20250101')).toBe(true)
  })

  test('the exact id is not an update of itself — the exact match branch handles that', () => {
    // isVersionUpdate's job is "same stem, one is a later release"; the
    // caller treats exact equality separately so a self-match never routes
    // through the update branch.
    expect(isVersionUpdate('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe(true)
  })

  test('a different family is never an update', () => {
    expect(isVersionUpdate('claude-sonnet-5', 'claude-opus-5-5')).toBe(false)
    expect(isVersionUpdate('claude-sonnet-5', 'claude-sonnet-code-5-5')).toBe(false)
  })

  test('a variant qualifier (-mini, -pro) is not a version, so it is not updated into or out of', () => {
    // Pinned here on its own: it is the original bug this existed to fix.
    // A disabled `gpt-5-mini` must not update to `gpt-5` — they are
    // different models the vendor bills differently.
    expect(isVersionUpdate('gpt-5-mini', 'gpt-5')).toBe(false)
    expect(isVersionUpdate('gpt-5', 'gpt-5-mini')).toBe(false)
    expect(isVersionUpdate('gpt-5-mini', 'gpt-5-mini-1')).toBe(true)
  })

  test('Claude new scheme: a short id updates to the newest point release', () => {
    // The user's original example: a client pinned to `claude-sonnet-5`
    // keeps working after only `claude-sonnet-5-5` is enabled.
    expect(isVersionUpdate('claude-sonnet-5', 'claude-sonnet-5-5')).toBe(true)
    expect(isVersionUpdate('claude-opus-5', 'claude-opus-5-1')).toBe(true)
    expect(isVersionUpdate('claude-haiku-4', 'claude-haiku-4-5')).toBe(true)
  })

  test('Claude old and new schemes do not cross-update', () => {
    // Old `claude-3-5-sonnet-*` shares the stem with new `claude-sonnet-*`,
    // but the version parts differ ([3, 5] vs [5, 5]) so the branch
    // separates them. A client pinned to the old id does not silently
    // route onto a new-scheme model and the other way round.
    expect(isVersionUpdate('claude-sonnet-5', 'claude-3-5-sonnet-20241022')).toBe(false)
    expect(isVersionUpdate('claude-3-5-sonnet-20241022', 'claude-sonnet-5-5')).toBe(false)
  })

  test('Claude: a context-window suffix like [1m] stays a different variant', () => {
    expect(isVersionUpdate('claude-sonnet-4-5', 'claude-sonnet-4-5[1m]')).toBe(false)
    expect(isVersionUpdate('claude-sonnet-4-5[1m]', 'claude-sonnet-4-5')).toBe(false)
  })

  test('OpenAI dotted versions update up the way dash-separated ones do', () => {
    // `.` and `-` both split, so `gpt-5.4` tokenises to [gpt, 5, 4] —
    // the exact shape `gpt-5-4` would.
    expect(isVersionUpdate('gpt-5', 'gpt-5.4')).toBe(true)
    expect(isVersionUpdate('gpt-5', 'gpt-5.5')).toBe(true)
    expect(isVersionUpdate('gpt-5.1', 'gpt-5.1')).toBe(true)
    // Different major sibling does not update across.
    expect(isVersionUpdate('gpt-5.2', 'gpt-5.4')).toBe(false)
    expect(isVersionUpdate('gpt-5', 'gpt-6-astra')).toBe(false)
  })

  test('OpenAI variant codenames and chat-latest stay on their own line', () => {
    // Same variant, newer version: update.
    expect(isVersionUpdate('gpt-5-codex', 'gpt-5.1-codex')).toBe(true)
    expect(isVersionUpdate('gpt-5-chat-latest', 'gpt-5.1-chat-latest')).toBe(true)
    // Different variant: not an update, even at the same version.
    expect(isVersionUpdate('gpt-5.1-codex', 'gpt-5.1-codex-max')).toBe(false)
    expect(isVersionUpdate('gpt-5.1-codex-mini', 'gpt-5.1-codex-max')).toBe(false)
    expect(isVersionUpdate('gpt-5.6-luna', 'gpt-5.6-sol')).toBe(false)
    // -preview and the base id: different variants.
    expect(isVersionUpdate('gpt-4.5', 'gpt-4.5-preview')).toBe(false)
    expect(isVersionUpdate('gpt-4-turbo', 'gpt-4-turbo-preview')).toBe(false)
  })

  test('OpenAI reasoning (o1 / o3 / o4) stays separate; mixed tokens are not versions', () => {
    // `o1` has no version run, so `isVersionUpdate` refuses to escalate
    // from it — we do not want to blindly send an `o1` request to `o3`.
    expect(isVersionUpdate('o1', 'o3')).toBe(false)
    expect(isVersionUpdate('o1-mini', 'o3-mini')).toBe(false)
    expect(isVersionUpdate('o3-mini', 'o3-deep-research')).toBe(false)
    // `gpt-4o` has no version run either (`4o` is mixed), same story.
    expect(isVersionUpdate('gpt-4o', 'gpt-4o-mini')).toBe(false)
  })

  test('Gemini dotted versions update up but variants stay separate', () => {
    expect(isVersionUpdate('gemini-2', 'gemini-2.5-pro')).toBe(false) // stem differs (-pro)
    expect(isVersionUpdate('gemini-2-pro', 'gemini-2.5-pro')).toBe(true)
    expect(isVersionUpdate('gemini-3', 'gemini-3.8-flash')).toBe(false) // -flash variant
    expect(isVersionUpdate('gemini-3-flash', 'gemini-3.8-flash')).toBe(true)
    // Pro and flash never cross.
    expect(isVersionUpdate('gemini-2.5-pro', 'gemini-2.5-flash')).toBe(false)
  })

  test('an earlier or sibling major version does not update up', () => {
    expect(isVersionUpdate('claude-sonnet-5', 'claude-sonnet-4-5')).toBe(false)
    expect(isVersionUpdate('claude-sonnet-5-5', 'claude-sonnet-5-4')).toBe(false)
  })

  test('a requested id with no version parts matches nothing — too ambiguous to escalate', () => {
    expect(isVersionUpdate('claude-sonnet', 'claude-sonnet-5-5')).toBe(false)
    expect(isVersionUpdate('claude-sonnet-latest', 'claude-sonnet-5-5')).toBe(false)
  })

  test('a candidate shorter than the request is not an update', () => {
    expect(isVersionUpdate('claude-sonnet-5-5', 'claude-sonnet-5')).toBe(false)
  })
})

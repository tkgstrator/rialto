/**
 * Locale parity.
 *
 * The three bundles are loaded as one `resources` object by `src/i18n.ts`,
 * so a key that exists only in `en` does not fail anywhere — it silently
 * falls back and the other two languages ship an English string. The
 * reverse is worse: a key present only in `ja` is dead weight nobody
 * notices. Both are cheap to catch here and expensive to catch by eye.
 *
 * The interpolation check exists for the same reason. `t('a.b', { n })`
 * against a translation that spells the placeholder differently renders
 * the raw `{{...}}` to the user, and only in that language.
 *
 * The last two checks watch the two ends of the pipeline: that a key a
 * component asks for actually exists (otherwise the UI paints the key
 * path at the user), and that `ja` / `zh` were translated rather than
 * copied from `en`.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../../src/locales/en.json'
import ja from '../../src/locales/ja.json'
import zh from '../../src/locales/zh.json'

type Tree = { [key: string]: string | Tree }

const BUNDLES: readonly (readonly [string, Tree])[] = [
  ['en', en],
  ['ja', ja],
  ['zh', zh]
]

/** Flatten to `a.b.c` paths so a set difference reads as a key list. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

/** `{{name}}` occurrences, sorted and de-duplicated. */
const placeholders = (value: string): string[] =>
  [...new Set([...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort()

/** `<tag>` / `<tag/>` names, for the `Trans` components a string declares. */
const tags = (value: string): string[] =>
  [...new Set([...value.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\s*\/?>/g)].map((m) => m[1]))].sort()

/**
 * Keys whose value is deliberately the same in all three languages.
 *
 * Two kinds only: vocabulary the product itself defines and that appears
 * verbatim in config, logs and docs (`routed` / `passthrough`, the
 * `agent` / `subagent` lanes), and proper nouns or example values that
 * would be wrong to localise (Cloudflare Access, Redis, Powerline,
 * Markdown, a sample hostname). Translating either half would make the
 * UI disagree with the thing it is describing.
 */
const SHARED_VOCABULARY = new Set([
  'activity.requests.laneAgent',
  'activity.requests.laneSubagent',
  // Codex names its own quota windows `primary` / `secondary`. The
  // collector's metric keys (`codex.primary`) and Overview's quota rows
  // print them verbatim, so a translated label here would disagree with
  // every other place the same window is named.
  'activity.usage.windowPrimary',
  'activity.usage.windowSecondary',
  'providers.connect.connectedPill',
  'providers.connect.pillSubscription',
  'providers.connect.redirectPlaceholder',
  'providers.rail.oauth',
  'routing.chain.modePassthroughLabel',
  'routing.chain.modeRoutedLabel',
  'routing.common.laneAgent',
  'routing.common.laneSubagent',
  'routing.common.modePassthrough',
  'routing.common.modeRouted',
  'settings.access.badgeConfigured',
  'settings.access.guardAccessTitle',
  'settings.access.issueNamePlaceholder',
  'settings.access.teamDomainPlaceholder',
  // A file name, a path and an HTTP request line: each names the artefact
  // itself, so a translated one would point at something that does not exist.
  'settings.advanced.subtitleConfig',
  'settings.advanced.subtitleHealth',
  'settings.logging.levelHint',
  'settings.personas.markdown',
  'settings.server.redis',
  'settings.statusline.stylePowerline',
  'shell.identityAccess'
])

const SRC = join(import.meta.dir, '..', '..', 'src')

/** `src/generated/` inlines the whole Prisma schema as one string literal. */
const SKIP_DIRS = new Set(['generated', 'locales'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

// Only literal call sites. Keys reached through a variable — `labelKey`
// tables, a `t` passed as a parameter — cannot be seen from here, which
// is exactly why this test asserts in one direction only: every literal
// must resolve, but a key with no literal is NOT proof of a dead key.
const LITERAL_KEY = /(?:\bt\(\s*|i18nKey=)['"]([^'"]+)['"]/g
const KEY_SHAPE = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/

function usedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(LITERAL_KEY)) {
      if (KEY_SHAPE.test(match[1])) keys.add(match[1])
    }
  }
  return keys
}

const FLAT = new Map(BUNDLES.map(([lang, tree]) => [lang, flatten(tree)]))
const EN = FLAT.get('en') ?? new Map()

describe('locale parity', () => {
  test('en is non-empty', () => {
    expect(EN.size).toBeGreaterThan(0)
  })

  for (const lang of ['ja', 'zh']) {
    const other = FLAT.get(lang) ?? new Map()

    test(`${lang} has no keys missing from en`, () => {
      expect([...EN.keys()].filter((k) => !other.has(k)).sort()).toEqual([])
    })

    test(`${lang} has no keys en does not declare`, () => {
      expect([...other.keys()].filter((k) => !EN.has(k)).sort()).toEqual([])
    })

    test(`${lang} keeps every interpolation placeholder`, () => {
      const mismatched = [...EN.entries()]
        .filter(([key, value]) => {
          const translated = other.get(key)
          return translated !== undefined && placeholders(value).join(',') !== placeholders(translated).join(',')
        })
        .map(([key]) => key)
      expect(mismatched).toEqual([])
    })

    test(`${lang} keeps every Trans component tag`, () => {
      const mismatched = [...EN.entries()]
        .filter(([key, value]) => {
          const translated = other.get(key)
          return translated !== undefined && tags(value).join(',') !== tags(translated).join(',')
        })
        .map(([key]) => key)
      expect(mismatched).toEqual([])
    })

    test(`${lang} has no empty strings`, () => {
      expect([...other.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k)).toEqual([])
    })

    test(`${lang} is translated, not copied from en`, () => {
      const copied = [...EN.entries()]
        .filter(([key, value]) => other.get(key) === value && !SHARED_VOCABULARY.has(key))
        // A value with no run of latin letters carries no prose to
        // translate — a bare number, an arrow, a `·` separator. The
        // placeholder names are stripped first: `{{sessionId}} · {{inbound}}`
        // is punctuation and two variable names, and demanding a different
        // spelling of it in each locale would mean renaming the variables.
        .filter(([, value]) => /[a-zA-Z]{4,}/.test(value.replace(/\{\{[^}]*\}\}/g, '')))
        .map(([key]) => key)
      expect(copied).toEqual([])
    })
  }

  test('every key the code asks for exists in en', () => {
    const unknown = [...usedKeys()].filter((key) => !EN.has(key)).sort()
    expect(unknown).toEqual([])
  })
})

/**
 * Fenced code in a transcript turn.
 *
 * The tokenizer is one left-to-right pass rather than a chain of
 * regexes, and the tests that matter are the ones a chain gets wrong: a
 * keyword inside a string, a comment marker inside a URL, an
 * unterminated quote at the end of a truncated capture.
 */

import { describe, expect, test } from 'bun:test'
import { splitTurn, tokenizeCode } from '../../src/lib/sessions/code'

const kindOf = (src: string, lang: string, needle: string) =>
  tokenizeCode(src, lang).find((token) => token.text.includes(needle))?.kind

describe('splitTurn', () => {
  test('prose stays prose', () => {
    expect(splitTurn('just a sentence')).toEqual([{ kind: 'text', text: 'just a sentence' }])
  })

  test('a fenced block becomes its own segment, with its language', () => {
    expect(splitTurn('before\n```ts\nconst a = 1\n```\nafter')).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'code', lang: 'ts', body: 'const a = 1' },
      { kind: 'text', text: 'after' }
    ])
  })

  test('an unlabelled fence still opens a block', () => {
    expect(splitTurn('```\nplain\n```')).toEqual([{ kind: 'code', lang: '', body: 'plain' }])
  })

  test('an unclosed fence takes the rest — a truncated capture is the common case', () => {
    expect(splitTurn('see:\n```py\ndef f():\n    return 1')).toEqual([
      { kind: 'text', text: 'see:' },
      { kind: 'code', lang: 'py', body: 'def f():\n    return 1' }
    ])
  })

  test('two blocks in one turn', () => {
    const segments = splitTurn('```sh\nls\n```\nthen\n```sh\npwd\n```')
    expect(segments.map((s) => s.kind)).toEqual(['code', 'text', 'code'])
  })
})

describe('tokenizeCode', () => {
  test('keywords, strings, numbers and comments each get their class', () => {
    expect(kindOf('const a = 1', 'ts', 'const')).toBe('keyword')
    expect(kindOf("const a = 'x'", 'ts', "'x'")).toBe('string')
    expect(kindOf('const a = 42', 'ts', '42')).toBe('number')
    expect(kindOf('// note', 'ts', '// note')).toBe('comment')
  })

  test('a keyword inside a string stays a string', () => {
    // The failure a regex chain makes: `return` painted inside the quotes.
    const tokens = tokenizeCode(`const s = 'return if for'`, 'ts')
    expect(tokens.some((t) => t.kind === 'keyword' && t.text === 'return')).toBe(false)
    expect(tokens.some((t) => t.kind === 'string' && t.text.includes('return'))).toBe(true)
  })

  test('a comment marker inside a string is not a comment', () => {
    const tokens = tokenizeCode(`const u = 'https://example.com/x'`, 'ts')
    expect(tokens.some((t) => t.kind === 'comment')).toBe(false)
  })

  test('an escaped quote does not end the string', () => {
    const tokens = tokenizeCode(`const s = 'it\\'s'`, 'ts')
    expect(tokens.filter((t) => t.kind === 'string')).toHaveLength(1)
  })

  test('an unterminated quote ends at the line, not at the file', () => {
    const tokens = tokenizeCode("const s = 'oops\nconst t = 2", 'ts')
    expect(tokens.some((t) => t.kind === 'keyword' && t.text === 'const')).toBe(true)
  })

  test('the comment marker follows the language', () => {
    expect(kindOf('# note', 'python', '# note')).toBe('comment')
    expect(kindOf('-- note', 'sql', '-- note')).toBe('comment')
    // `#` is not a comment in a C-like language — it is a fragment id or
    // a preprocessor line, and greying the rest of the line would be a lie.
    expect(kindOf('# note', 'ts', '#')).not.toBe('comment')
  })

  test('json has no keywords beyond its literals', () => {
    expect(kindOf('{"a": true}', 'json', 'true')).toBe('keyword')
    expect(kindOf('{"const": 1}', 'json', '"const"')).toBe('string')
  })

  test('every character of the source survives tokenizing', () => {
    const src = 'def f(x):\n  # halve\n  return x / 2  # done\n'
    expect(
      tokenizeCode(src, 'python')
        .map((t) => t.text)
        .join('')
    ).toBe(src)
  })

  test('an empty body yields no tokens', () => {
    expect(tokenizeCode('', 'ts')).toEqual([])
  })
})

/**
 * Fenced code inside a captured turn: finding it, and colouring it.
 *
 * A transcript turn arrives as one string. Rendered as one paragraph it
 * wraps prose and code together, which is unreadable exactly where it
 * matters — the code half is usually the half the operator opened the
 * session to read.
 *
 * The highlighter is deliberately small: four token classes (comment,
 * string, keyword, number) and one pass. It is not a parser and does not
 * try to be — a transcript contains whatever language the model felt
 * like emitting, half of it truncated, and a highlighter that guesses
 * structure would be wrong in ways a reader cannot see. Four classes are
 * what make a block skimmable; the rest is decoration.
 *
 * The pass is a single left-to-right scan on purpose. Chaining regexes
 * over the source — comments, then strings, then keywords — colours the
 * keyword inside a string and the `//` inside a URL, because each pass
 * cannot see what the previous one already claimed.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number'

export interface CodeToken {
  text: string
  kind: TokenKind
}

export type Segment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; body: string }

const FENCE = /^ {0,3}```([^\n`]*)$/

/**
 * Split a turn into prose and fenced code.
 *
 * An unclosed fence takes the rest of the turn: a truncated capture is
 * the common case, and showing that tail as prose is how a half-captured
 * function ends up wrapped into a paragraph.
 */
export function splitTurn(text: string): Segment[] {
  const state: {
    out: Segment[]
    prose: string[]
    code: { lang: string; body: string[] } | null
  } = { out: [], prose: [], code: null }

  const flushProse = () => {
    const joined = state.prose.join('\n')
    state.prose.length = 0
    if (joined.trim() !== '') state.out.push({ kind: 'text', text: joined })
  }
  const flushCode = () => {
    if (state.code === null) return
    state.out.push({ kind: 'code', lang: state.code.lang, body: state.code.body.join('\n') })
    state.code = null
  }

  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)
    if (state.code !== null) {
      if (fence === null) state.code.body.push(line)
      else flushCode()
      continue
    }
    if (fence === null) {
      state.prose.push(line)
      continue
    }
    flushProse()
    state.code = { lang: fence[1].trim().toLowerCase(), body: [] }
  }
  // An unclosed fence is the common case on a truncated capture, so it
  // closes itself here rather than falling back to prose.
  flushCode()
  flushProse()
  return state.out
}

// Keywords worth colouring: the ones that carry a line's shape. Kept as
// one shared set plus per-family extras rather than a grammar per
// language, because a transcript's fence label is a hint at best — an
// unlabelled block still has to look like code.
const SHARED = [
  'return',
  'if',
  'else',
  'for',
  'while',
  'break',
  'continue',
  'function',
  'class',
  'new',
  'try',
  'catch',
  'finally',
  'throw',
  'switch',
  'case',
  'default',
  'import',
  'export',
  'from',
  'as',
  'async',
  'await',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'in',
  'of',
  'not',
  'and',
  'or'
]
const FAMILIES: Record<string, string[]> = {
  js: ['const', 'let', 'var', 'type', 'interface', 'enum', 'extends', 'implements', 'typeof', 'instanceof', 'yield'],
  py: ['def', 'lambda', 'None', 'True', 'False', 'elif', 'pass', 'with', 'yield', 'raise', 'global', 'nonlocal'],
  go: ['func', 'package', 'var', 'type', 'struct', 'defer', 'go', 'range', 'chan', 'map', 'nil'],
  rust: ['fn', 'let', 'mut', 'pub', 'impl', 'struct', 'enum', 'trait', 'match', 'use', 'crate', 'Some', 'None'],
  sql: ['select', 'insert', 'update', 'delete', 'from', 'where', 'join', 'group', 'order', 'limit', 'values', 'set'],
  sh: ['echo', 'cd', 'export', 'local', 'then', 'fi', 'do', 'done', 'elif', 'esac']
}

/** Which keyword family and comment syntax a fence label implies. */
function dialect(lang: string): { words: Set<string>; line: string[]; block: boolean } {
  const id = lang.toLowerCase()
  if (['py', 'python'].includes(id)) return { words: new Set([...SHARED, ...FAMILIES.py]), line: ['#'], block: false }
  if (['sh', 'bash', 'zsh', 'shell', 'console'].includes(id)) {
    return { words: new Set([...SHARED, ...FAMILIES.sh]), line: ['#'], block: false }
  }
  if (['yaml', 'yml', 'toml', 'ini', 'dockerfile'].includes(id)) return { words: new Set(), line: ['#'], block: false }
  if (id === 'sql') return { words: new Set([...SHARED, ...FAMILIES.sql]), line: ['--'], block: true }
  if (id === 'go') return { words: new Set([...SHARED, ...FAMILIES.go]), line: ['//'], block: true }
  if (['rs', 'rust'].includes(id)) return { words: new Set([...SHARED, ...FAMILIES.rust]), line: ['//'], block: true }
  // JSON has no keywords beyond its three literals and no comments, but
  // its strings and numbers are exactly what a reader scans for.
  if (id === 'json') return { words: new Set(['true', 'false', 'null']), line: [], block: false }
  return { words: new Set([...SHARED, ...FAMILIES.js]), line: ['//'], block: true }
}

// One scanner per dialect, built once and cached: the alternation order
// IS the precedence — a `//` inside a string must be claimed by the
// string branch before the comment branch ever sees it — and writing it
// as one regex keeps that order in a single readable place instead of
// spread across a hand-rolled cursor.
const SCANNERS = new Map<string, RegExp>()

// Joined rather than concatenated: the backtick alternative cannot sit in a
// template literal without changing what the regex source says.
const STRING = [String.raw`'(?:\\.|[^'\\\n])*'?`, String.raw`"(?:\\.|[^"\\\n])*"?`, '`(?:\\\\.|[^`\\\\])*`?'].join('|')

function scannerFor(lang: string): RegExp {
  const cached = SCANNERS.get(lang)
  if (cached !== undefined) return cached
  const { line, block } = dialect(lang)
  const parts = [
    ...line.map((marker) => `(?<comment>${marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[^\\n]*)`),
    ...(block ? [String.raw`(?<blockComment>/\*[\s\S]*?(?:\*/|$))`] : []),
    `(?<string>${STRING})`,
    String.raw`(?<number>\d[\w.]*)`,
    String.raw`(?<ident>[A-Za-z_$][\w$]*)`,
    String.raw`(?<other>[\s\S])`
  ]
  // Named groups have to be unique, so the second line-comment marker (a
  // dialect never has more than one today) would clash — hence the join
  // rather than a loop that renames.
  const scanner = new RegExp(parts.join('|'), 'g')
  SCANNERS.set(lang, scanner)
  return scanner
}

// Group name → token class, in the scanner's own alternation order. An
// identifier is resolved against the dialect's keywords at match time.
const GROUP_KINDS: readonly (readonly [string, TokenKind | 'ident'])[] = [
  ['comment', 'comment'],
  ['blockComment', 'comment'],
  ['string', 'string'],
  ['number', 'number'],
  ['ident', 'ident']
]

export function tokenizeCode(source: string, lang: string): CodeToken[] {
  const { words } = dialect(lang)
  const out: CodeToken[] = []
  const push = (text: string, kind: TokenKind) => {
    if (text === '') return
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }

  for (const match of source.matchAll(scannerFor(lang))) {
    const groups = match.groups === undefined ? {} : match.groups
    const hit = GROUP_KINDS.find(([group]) => groups[group] !== undefined)
    const kind = hit === undefined ? 'plain' : hit[1]
    push(match[0], kind === 'ident' ? (words.has(match[0]) ? 'keyword' : 'plain') : kind)
  }
  return out
}

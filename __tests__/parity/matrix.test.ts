/**
 * Checks on the parity matrix itself.
 *
 * master-plan §2-5 is done when every cell carries a label — supported,
 * or unsupported with a reason — and a test. Since **the deliverable is
 * finding the blank cells**, the table needs its own guarantee that a
 * blank cannot exist: otherwise adding a surface quietly leaves a table
 * one column short.
 *
 * This reads docs/architecture/inbound-parity.md and checks that
 *   - the surface columns match the descriptor registry
 *   - all ten feature rows are present
 *   - every cell carries one of the three labels
 *   - unsupported and partial cells point at a note that exists
 *   - each row names a test file that exists
 *
 * The string literals below are matched against that document and are
 * data, not prose: they must stay in step with the file's own headings
 * and labels.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { INBOUND_SURFACES } from '../../src/llms/inbound/surfaces'

const COMPLETION_SURFACES = INBOUND_SURFACES.filter((surface) => surface.operation === 'completion')

const DOC_PATH = new URL('../../docs/architecture/inbound-parity.md', import.meta.url).pathname
const REPO_ROOT = new URL('../../', import.meta.url).pathname

// The feature axis master-plan §2-5 defines. This fails if the table
// drops one of these ten rows or grows an eleventh.
const FEATURES: readonly string[] = [
  'streaming (SSE)',
  'non-streaming aggregation',
  'tool use',
  'system prompt',
  'image input',
  'thinking / reasoning',
  'usage record (RequestLog)',
  'error shape',
  'cache token accounting',
  'failover / 429'
]

const LABELS: readonly string[] = ['Supported', 'Partial', 'Unsupported']

const doc = await Bun.file(DOC_PATH).text()

/** The body from `## <heading>` up to the next `## `. */
const sectionOf = (heading: string): string => {
  const start = doc.indexOf(`## ${heading}`)
  if (start === -1) throw new Error(`section not found: ${heading}`)
  const rest = doc.slice(start + heading.length + 3)
  const end = rest.indexOf('\n## ')
  return end === -1 ? rest : rest.slice(0, end)
}

/** Split a markdown table into rows of cells, dropping the rule row. */
const tableRows = (section: string): string[][] =>
  section
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    )
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))

const matrix = tableRows(sectionOf('Matrix'))
const header = matrix[0]
const body = matrix.slice(1)

describe('the shape of the matrix', () => {
  test("the columns correspond to the registry's four surfaces", () => {
    // The headings are abbreviated, so match on the tail of each
    // descriptor's path. Adding a surface without adding a column fails
    // here.
    expect(header.length).toBe(COMPLETION_SURFACES.length + 1)
    expect(header.slice(1)).toEqual(['messages', 'chat/completions', 'responses', 'gemini'])
  })

  test('the rows are exactly the ten features master-plan names', () => {
    expect(body.map((row) => row[0])).toEqual(FEATURES)
  })

  test('all 40 cells carry a label, leaving no blank', () => {
    const cells = body.flatMap((row) => row.slice(1))
    expect(cells.length).toBe(FEATURES.length * COMPLETION_SURFACES.length)
    for (const cell of cells) {
      expect(cell.length).toBeGreaterThan(0)
      const label = cell.replace(/\s*\(\d+\)\s*$/, '')
      expect(LABELS).toContain(label)
    }
  })
})

describe('the notes', () => {
  // Pick up numbers from both `### (n) ...` and the combined
  // `### (2)(3)(4) …` heading form.
  const defined = new Set(
    doc
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .flatMap((line) => [...line.matchAll(/\((\d+)\)/g)].map((m) => m[1]))
  )

  test('every unsupported or partial cell points at a note', () => {
    for (const row of body) {
      for (const cell of row.slice(1)) {
        const label = cell.replace(/\s*\(\d+\)\s*$/, '')
        if (label === 'Supported') continue
        expect(cell).toMatch(/\(\d+\)$/)
      }
    }
  })

  test('every note number a cell points at exists', () => {
    const referenced = new Set(
      body.flatMap((row) => row.slice(1)).flatMap((cell) => [...cell.matchAll(/\((\d+)\)/g)].map((m) => m[1]))
    )
    for (const id of referenced) expect(defined).toContain(id)
  })
})

describe('the backing tests exist', () => {
  const rows = tableRows(sectionOf('Backing tests per row')).slice(1)

  test('the backing-test table lists all ten features', () => {
    expect(rows.map((row) => row[0])).toEqual(FEATURES)
  })

  test('every test file it names exists', () => {
    const paths = rows.flatMap((row) => [...row[1].matchAll(/`([^`]+\.test\.ts)`/g)].map((m) => m[1]))
    expect(paths.length).toBeGreaterThanOrEqual(FEATURES.length)
    for (const path of paths) expect(existsSync(`${REPO_ROOT}${path}`)).toBe(true)
  })
})

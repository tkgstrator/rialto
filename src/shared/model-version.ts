/**
 * Which of two model ids is the newer release, read from the name alone.
 *
 * Rialto keeps no list of models: a tier routes to the newest switched-on
 * model its name says, so "newest" has to come from the id a vendor
 * publishes. Vendors number releases in the id (`claude-sonnet-4-6`,
 * `claude-sonnet-5-5`, `gpt-5.4-mini`), and some pin a snapshot with an
 * 8-digit date (`claude-sonnet-4-20250514`). A date is a snapshot of a
 * version, never a newer version, so it only orders ids whose numbers tie:
 * `claude-sonnet-4-6` is newer than `claude-sonnet-4-20250514`.
 *
 * Browser-safe and import-free: the provider page previews the same
 * ordering the server routes by.
 */

export interface ModelVersion {
  // The first run of short numeric tokens: [5, 5] for claude-sonnet-5-5.
  // Empty for an id with no version (it ranks below every versioned one).
  parts: readonly number[]
  // The first 8-digit token (a snapshot date), or null.
  date: number | null
}

const VERSION_TOKEN = /^\d{1,3}$/
const DATE_TOKEN = /^\d{8}$/

/**
 * The version an id carries.
 *
 * Tokens are split on anything that is not a letter or digit, so `5.4`,
 * `5-5`, `4.5[1m]` and `us.anthropic.claude-sonnet-4-20250514-v1:0` all
 * read. The run starts at the first 1–3 digit token and stops at the first
 * token that is not one — a family word (`claude-3-5-sonnet`), a date, a
 * 4-digit MMDD (`gpt-4-0613`) or a mixed token (`1m`, `4o`).
 */
export function parseModelVersion(name: string): ModelVersion {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
  const start = tokens.findIndex((t) => VERSION_TOKEN.test(t))
  const rest = start === -1 ? [] : tokens.slice(start)
  const end = rest.findIndex((t) => !VERSION_TOKEN.test(t))
  const run = end === -1 ? rest : rest.slice(0, end)
  const date = tokens.find((t) => DATE_TOKEN.test(t))
  return { parts: run.map(Number), date: date === undefined ? null : Number(date) }
}

// A missing part reads as 0, so `claude-opus-4` and `claude-opus-4-0` tie.
const partAt = (parts: readonly number[], i: number): number => (i < parts.length ? parts[i] : 0)

/**
 * Sort comparator, newest first: negative when `a` is the newer id.
 *
 * A total order, so a sort is deterministic whatever the input order:
 * 1. the version numbers, left to right — a higher version always wins;
 * 2. at an equal version, the undated id first (it is the vendor's moving
 *    pointer to the latest snapshot), then the later date;
 * 3. the name, by code unit, so the result does not depend on locale.
 */
export function newestFirst(a: string, b: string): number {
  const va = parseModelVersion(a)
  const vb = parseModelVersion(b)
  const length = Math.max(va.parts.length, vb.parts.length)
  const differs = Array.from({ length }, (_, i) => i).find((i) => partAt(va.parts, i) !== partAt(vb.parts, i))
  if (differs !== undefined) return partAt(vb.parts, differs) - partAt(va.parts, differs)
  if (va.date !== vb.date) {
    if (va.date === null) return -1
    if (vb.date === null) return 1
    return vb.date - va.date
  }
  if (a === b) return 0
  return a < b ? -1 : 1
}

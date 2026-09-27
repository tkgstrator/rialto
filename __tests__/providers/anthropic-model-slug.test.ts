/**
 * Display name → API model id.
 *
 * This was broken two ways, both surfacing as the same symptom: a model
 * is on the pricing page but never reaches the catalog.
 *
 * 1. **The family list was hard-coded to Opus / Sonnet / Haiku.**
 *    `Claude Fable 5.1` matched no branch, fell into the scraper's
 *    "Skipped (no API id mapping)" and was discarded.
 * 2. **`.0` was appended unconditionally.** The naming changed at the 5
 *    generation: `claude-opus-5` exists, `claude-opus-5-0` does not.
 *    Appending it invents ids that are not real — and it did, emitting
 *    `claude-opus-5-0` and `claude-sonnet-5-0`.
 *
 * The expected values are taken verbatim from the "Claude API ID" rows on
 * Anthropic's models overview and pricing pages.
 */

import { describe, expect, test } from 'bun:test'
import { __testables } from '../../src/vendors/anthropic'

const { claude4PlusSlug, headerModelName, parsePricingPage } = __testables

describe('Anthropic grouped pricing table', () => {
  test('joins the display name to the model ID and reads standard and cache prices', () => {
    const pricing = `<table><thead>
      <tr><th>Model</th><th colspan="2">Base tokens</th><th colspan="3">Prompt caching</th></tr>
      <tr><th>Name</th><th>Input</th><th>Output</th><th>5m writes</th><th>1h writes</th><th>Hits and refreshes</th></tr>
    </thead><tbody><tr>
      <td>Claude Opus 5.5For long-running agentic coding and knowledge work</td>
      <td>$4 / MTok</td><td>$20 / MTok</td><td>$5 / MTok</td><td>$8 / MTok</td><td>$0.20 / MTok</td>
    </tr></tbody></table>`
    expect(parsePricingPage(pricing, null)).toEqual([
      {
        apiId: 'claude-opus-5-5',
        inputPer1M: 4,
        outputPer1M: 20,
        cachedInputPer1M: 0.2,
        contextWindow: null,
        legacy: false
      }
    ])
  })

  test('does not mistake an unrelated price table for the model table', () => {
    expect(parsePricingPage('<table><tr><th>Input</th><th>Output</th></tr></table>', null)).toBeNull()
  })
})

describe('claude4PlusSlug', () => {
  test('the 5 generation takes no suffix when there is no minor', () => {
    expect(claude4PlusSlug('Claude Opus 5')).toBe('claude-opus-5')
    expect(claude4PlusSlug('Claude Sonnet 5')).toBe('claude-sonnet-5')
    expect(claude4PlusSlug('Claude Fable 5')).toBe('claude-fable-5')
  })

  test('the 4 generation does append -0 when there is no minor', () => {
    // The one place the rule differs. Making it uniform by applying it
    // to the 5 generation too is where the bug came from.
    expect(claude4PlusSlug('Claude Opus 4')).toBe('claude-opus-4-0')
    expect(claude4PlusSlug('Claude Sonnet 4')).toBe('claude-sonnet-4-0')
  })

  test('a minor version is appended as-is', () => {
    expect(claude4PlusSlug('Claude Opus 4.7')).toBe('claude-opus-4-7')
    expect(claude4PlusSlug('Claude Haiku 4.5')).toBe('claude-haiku-4-5')
    expect(claude4PlusSlug('Claude Fable 5.1')).toBe('claude-fable-5-1')
    expect(claude4PlusSlug('Claude Mythos 5.1')).toBe('claude-mythos-5-1')
  })

  test('Fable and Mythos are recognised as families', () => {
    // Unrecognised, they are discarded outright as "no API id mapping".
    expect(claude4PlusSlug('Claude Fable 5.1')).not.toBeNull()
    expect(claude4PlusSlug('Claude Mythos 5')).not.toBeNull()
  })

  test('generations before 4 are left to another path', () => {
    expect(claude4PlusSlug('Claude Haiku 3.5')).toBeNull()
    expect(claude4PlusSlug('Claude 3 Opus')).toBeNull()
  })

  test('anything of a different shape is null', () => {
    expect(claude4PlusSlug('GPT-5')).toBeNull()
    expect(claude4PlusSlug('Claude Opus')).toBeNull()
    expect(claude4PlusSlug('')).toBeNull()
  })

  test('never invents an id', () => {
    // The regression itself. Neither of these exists at Anthropic.
    const produced = ['Claude Opus 5', 'Claude Sonnet 5', 'Claude Fable 5'].map(claude4PlusSlug)
    expect(produced).not.toContain('claude-opus-5-0')
    expect(produced).not.toContain('claude-sonnet-5-0')
    expect(produced).not.toContain('claude-fable-5-0')
  })
})

describe('headerModelName', () => {
  test('takes just the model name out of a header run together with its description', () => {
    // Stripping the markup from a comparison-table header concatenates
    // the name and the description with no separator. Keying on the
    // whole string meant it could never match the pricing page's
    // "Claude Fable 5.1", leaving contextWindow null on every model.
    expect(headerModelName('Claude Fable 5.1For demanding reasoning and long-horizon agentic work')).toBe(
      'Claude Fable 5.1'
    )
    expect(headerModelName('Claude Haiku 4.5The fastest model with near-frontier intelligence')).toBe(
      'Claude Haiku 4.5'
    )
  })

  test('does not drop the minor number', () => {
    // The existing modelPrefix requires a trailing \b, which fails
    // between "1" and "F" and backtracks to "Claude Fable 5" — a
    // different model.
    expect(headerModelName('Claude Fable 5.1For demanding')).not.toBe('Claude Fable 5')
  })

  test('a header with no description is read as-is', () => {
    expect(headerModelName('Claude Opus 5')).toBe('Claude Opus 5')
    expect(headerModelName('Claude Sonnet 5')).toBe('Claude Sonnet 5')
  })

  test('a header that is not a model name is null', () => {
    expect(headerModelName('Feature')).toBeNull()
    expect(headerModelName('')).toBeNull()
  })
})

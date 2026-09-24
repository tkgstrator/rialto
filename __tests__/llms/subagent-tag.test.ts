/**
 * The subagent tag is an external contract.
 *
 * The string lives in prompts users have already written into their own
 * subagent definitions, so the Rialto rename adds a spelling rather
 * than replacing one. Dropping the old name would silently route every
 * existing subagent request onto the agent lane's lists, with nothing in
 * the request to explain why — which is the failure these cases exist
 * to prevent.
 */
import { describe, expect, test } from 'bun:test'
import { stripSubagentTag } from '../../src/llms/router/request-signals'

// The tag is only recognised in the SECOND system block, which is where
// Claude Code puts it; a system array is [preamble, subagent marker].
const systemWith = (text: string) => [
  { type: 'text', text: 'preamble' },
  { type: 'text', text }
]

describe('stripSubagentTag', () => {
  for (const tag of ['CCR-SUBAGENT-MODEL', 'RIALTO-SUBAGENT-MODEL']) {
    test(`recognises <${tag}> and strips it so the marker never reaches upstream`, () => {
      const system = systemWith(`<${tag}>anthropic,claude-opus-4-8</${tag}>rest of the prompt`)
      expect(stripSubagentTag(system)).toBe(true)
      expect(system[1].text).toBe('rest of the prompt')
    })

    test(`<${tag}> counts by presence, whatever value it carries`, () => {
      // The value is not used for routing — only that the tag is there.
      const system = systemWith(`<${tag}></${tag}>`)
      expect(stripSubagentTag(system)).toBe(true)
      expect(system[1].text).toBe('')
    })

    test(`an unclosed <${tag}> still counts as present and is left alone`, () => {
      const text = `<${tag}>anthropic,claude-opus-4-8`
      const system = systemWith(text)
      expect(stripSubagentTag(system)).toBe(true)
      // Rewriting a malformed tag risks mangling the prompt; the old
      // behaviour left it untouched and callers depend on that.
      expect(system[1].text).toBe(text)
    })
  }

  test('main-agent traffic is untouched', () => {
    const system = systemWith('You are a helpful assistant.')
    expect(stripSubagentTag(system)).toBe(false)
    expect(system[1].text).toBe('You are a helpful assistant.')
  })

  test('a tag that does not start the block is not a marker', () => {
    // Matching mid-string would let ordinary prose mentioning the tag
    // reroute a request.
    const system = systemWith('see <CCR-SUBAGENT-MODEL>x</CCR-SUBAGENT-MODEL> in the docs')
    expect(stripSubagentTag(system)).toBe(false)
  })

  test('an unknown tag name is not a marker', () => {
    expect(stripSubagentTag(systemWith('<OTHER-SUBAGENT-MODEL>x</OTHER-SUBAGENT-MODEL>'))).toBe(false)
  })

  test('a system that is absent, short, or not text is not a marker', () => {
    expect(stripSubagentTag(undefined)).toBe(false)
    expect(stripSubagentTag('a plain string system')).toBe(false)
    expect(stripSubagentTag([{ type: 'text', text: '<CCR-SUBAGENT-MODEL>x</CCR-SUBAGENT-MODEL>' }])).toBe(false)
    expect(stripSubagentTag([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe(false)
  })
})

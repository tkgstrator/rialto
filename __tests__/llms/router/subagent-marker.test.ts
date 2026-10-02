import { describe, expect, test } from 'bun:test'
import { stripSubagentTag } from '../../../src/llms/router/request-signals'

const billing = (extra: string) => ({
  type: 'text' as const,
  text: `x-anthropic-billing-header: cc_version=2.1.282.4f5; cc_entrypoint=cli;${extra}`
})

describe('Claude Code subagent marker', () => {
  test('cc_is_subagent=true in system[0] marks a subagent', () => {
    const system = [billing(' cc_is_subagent=true'), { type: 'text' as const, text: 'You are a Claude agent' }]
    expect(stripSubagentTag(system)).toBe(true)
  })
  test('the main agent header does not', () => {
    const system = [billing(''), { type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI" }]
    expect(stripSubagentTag(system)).toBe(false)
  })
  test('user text mentioning the marker elsewhere does not', () => {
    const system = [billing(''), { type: 'text' as const, text: 'cc_is_subagent=true' }]
    expect(stripSubagentTag(system)).toBe(false)
  })
})

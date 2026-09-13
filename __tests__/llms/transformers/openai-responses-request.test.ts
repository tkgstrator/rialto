import { describe, expect, test } from 'bun:test'
import { remapToolChoice, remapTools } from '../../../src/llms/transformers/openai/responses/request'

// remapToolChoice reshapes the unified Chat-Completions tool_choice into
// the flat Responses-API form. See the helper's block comment for the
// exact rules — the tests below pin each branch.

describe('remapToolChoice', () => {
  test('returns undefined when the request has no tool_choice', () => {
    expect(remapToolChoice(undefined)).toBeUndefined()
  })

  test('passes string literals through verbatim (auto / none / required)', () => {
    expect(remapToolChoice('auto')).toBe('auto')
    expect(remapToolChoice('none')).toBe('none')
    expect(remapToolChoice('required')).toBe('required')
  })

  test('flattens { type: "function", function: { name } } to { type, name }', () => {
    expect(remapToolChoice({ type: 'function', function: { name: 'WebSearch' } })).toEqual({
      type: 'function',
      name: 'WebSearch'
    })
  })

  test('collapses a web_search-targeting choice to the hosted-tool shape', () => {
    // remapTools emits `{type:'web_search'}` for the Anthropic hosted
    // web_search tool; a tool_choice pointing at it must match that
    // shape or the Responses API rejects the name as unknown.
    expect(remapToolChoice({ type: 'function', function: { name: 'web_search' } })).toEqual({ type: 'web_search' })
  })
})

// remapTools unwraps the unified nested `{type, function:{name, ...}}`
// into the flat Responses-API `{type, name, ...}`. A tool that arrived
// with no `function` object at all — Codex's `custom` and `local_shell`
// — is already in the upstream's own shape and has to come out untouched.

describe('remapTools', () => {
  test('returns an empty list when the request has no tools', () => {
    expect(remapTools(undefined)).toEqual([])
  })

  test('emits a tool carrying no function object verbatim', () => {
    expect(
      remapTools([{ type: 'custom', name: 'shell', description: 'Run a shell command' }, { type: 'local_shell' }])
    ).toEqual([{ type: 'custom', name: 'shell', description: 'Run a shell command' }, { type: 'local_shell' }])
  })

  test("keeps the caller's order when flat and nested tools are mixed", () => {
    expect(
      remapTools([
        { type: 'custom', name: 'shell' },
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up weather',
            parameters: { type: 'object', properties: {} }
          }
        },
        { type: 'local_shell' }
      ])
    ).toEqual([
      { type: 'custom', name: 'shell' },
      {
        type: 'function',
        name: 'get_weather',
        description: 'Look up weather',
        parameters: { type: 'object', properties: {} }
      },
      { type: 'local_shell' }
    ])
  })

  test('still collapses web_search to the hosted-tool shape at the end', () => {
    // The collapse reads tool names, so it has to skip the tools that
    // have none rather than crash on them.
    expect(
      remapTools([
        { type: 'custom', name: 'shell' },
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Hosted web search',
            parameters: { type: 'object', properties: {} }
          }
        }
      ])
    ).toEqual([{ type: 'custom', name: 'shell' }, { type: 'web_search' }])
  })
})

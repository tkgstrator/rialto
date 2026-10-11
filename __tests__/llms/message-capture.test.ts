import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import { redactToolArguments } from '../../src/api/v1/redact'
import { captureAssistantMessage } from '../../src/llms/pipeline/message-capture'
import type { MessageRecord } from '../../src/schemas/domain'

const input = { prompt: 'PRIVATE_PROMPT', subagent_type: 'general-purpose', model: 'haiku' }
const detected = { prompt_present: true, subagent_type_present: true, model_present: true }

async function capture(response: Response, redact = false) {
  const records: MessageRecord[] = []
  const logs: string[] = []
  await captureAssistantMessage(response.clone(), 'session-agent', {
    log: pino({ level: 'trace' }, { write: (line: string) => logs.push(line) }),
    recordMessages: async (entries) => {
      records.push(...entries.map((e) => ({ ...e, content: redact ? redactToolArguments(e.content) : e.content })))
    }
  })
  return { records, logs }
}

function jsonResponse(content: unknown[]) {
  return new Response(JSON.stringify({ role: 'assistant', content }), {
    headers: { 'content-type': 'application/json' }
  })
}

function sseResponse(events: unknown[], crlf = false) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  const bytes = new TextEncoder().encode(crlf ? text.replace(/\n/g, '\r\n') : text)
  // Transport boundaries deliberately cut across both SSE records and argument fragments.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const offset of Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => i * 7)) {
        controller.enqueue(bytes.slice(offset, offset + 7))
      }
      controller.close()
    }
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const start = (index: number, name: string, initial: unknown = {}) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id: `tool-${index}`, name, input: initial }
})
const delta = (index: number, partial_json: string) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json }
})
const stop = (index: number) => ({ type: 'content_block_stop', index })

const archived = (content: unknown) => [{ sessionId: 'session-agent', role: 'assistant', content }]

describe('Agent call capture', () => {
  test('annotates Agent and legacy Task JSON tool blocks without changing the response or logging arguments', async () => {
    const content = ['Agent', 'Task'].map((name) => ({ type: 'tool_use', id: name, name, input }))
    const response = jsonResponse(content)
    const { records, logs } = await capture(response)
    expect(records).toEqual(archived(content.map((block) => ({ ...block, agent_call: detected }))))
    expect(await response.json()).toEqual({ role: 'assistant', content })
    expect(logs.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'agent_call_detected', sessionId: 'session-agent', ...detected })
      ])
    )
    expect(logs.join('')).not.toContain('PRIVATE_PROMPT')
  })

  test('assembles interleaved fragmented arguments before detection, including CRLF and tiny transport chunks', async () => {
    const raw = JSON.stringify(input)
    const response = sseResponse(
      [
        start(1, 'Agent'),
        start(0, 'Bash'),
        delta(1, raw.slice(0, 19)),
        delta(0, '{"command":"pwd"}'),
        delta(1, raw.slice(19, 45)),
        stop(0),
        delta(1, raw.slice(45)),
        stop(1)
      ],
      true
    )
    const original = await response.clone().text()
    const { records, logs } = await capture(response)
    expect(records).toEqual(
      archived([
        { type: 'tool_use', id: 'tool-0', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_use', id: 'tool-1', name: 'Agent', input, agent_call: detected }
      ])
    )
    expect(await response.text()).toBe(original)
    expect(logs.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'agent_call_detected', sessionId: 'session-agent', ...detected })
      ])
    )
    expect(logs.join('')).not.toContain('PRIVATE_PROMPT')
  })

  test('supports start-block arguments and optional model on legacy Task streams', async () => {
    const args = { prompt: 'work', subagent_type: 'Explore' }
    const { records } = await capture(sseResponse([start(0, 'Task', args), stop(0)]))
    expect(records).toEqual(
      archived([
        {
          type: 'tool_use',
          id: 'tool-0',
          name: 'Task',
          input: args,
          agent_call: { ...detected, model_present: false }
        }
      ])
    )
  })

  for (const name of ['Agent', 'Task']) {
    for (const streamed of [false, true]) {
      test(`preserves the full ${name} prompt in ${streamed ? 'SSE' : 'JSON'} capture`, async () => {
        const args = { prompt: '日本語のタスク\n'.repeat(2000), subagent_type: 'Explore', model: 'sonnet' }
        const raw = JSON.stringify(args)
        const response = streamed
          ? sseResponse([start(0, name), delta(0, raw.slice(0, 1500)), delta(0, raw.slice(1500)), stop(0)])
          : jsonResponse([{ type: 'tool_use', id: 'tool-0', name, input: args }])
        const { records } = await capture(response)
        expect(records).toEqual(archived([{ type: 'tool_use', id: 'tool-0', name, input: args, agent_call: detected }]))
      })
    }
  }

  test('ordinary tools and malformed Agent arguments retain the preview limit', async () => {
    const args = { command: 'x'.repeat(2500) }
    const malformed = { prompt: 42, other: 'x'.repeat(2500) }
    const { records, logs } = await capture(
      jsonResponse([
        { type: 'tool_use', name: 'Bash', input: args },
        { type: 'tool_use', name: 'Agent', input: malformed }
      ])
    )
    expect(records).toEqual(
      archived([
        { type: 'tool_use', name: 'Bash', input: `${JSON.stringify(args).slice(0, 2000)}…`, input_truncated: true },
        {
          type: 'tool_use',
          name: 'Agent',
          input: `${JSON.stringify(malformed).slice(0, 2000)}…`,
          input_truncated: true,
          agent_call: { prompt_present: false, subagent_type_present: false, model_present: false }
        }
      ])
    )
    expect(logs).toHaveLength(1)
  })

  test('logs calls without a message persistence callback', async () => {
    const logs: string[] = []
    await captureAssistantMessage(
      jsonResponse([{ type: 'tool_use', id: 'call-1', name: 'Agent', input }]),
      'session-agent',
      {
        log: pino({ level: 'info' }, { write: (line: string) => logs.push(line) })
      }
    )
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0])).toMatchObject({
      event: 'agent_call_detected',
      sessionId: 'session-agent',
      toolUseId: 'call-1',
      toolName: 'Agent',
      ...detected
    })
    expect(logs.join('')).not.toContain('PRIVATE_PROMPT')
  })

  test('redaction retains only structural presence flags, not prompt, model or subagent values', async () => {
    const args = { prompt: 'SECRET_PROMPT'.repeat(1000), subagent_type: 'SECRET_TYPE', model: 'SECRET_MODEL' }
    const { records, logs } = await capture(jsonResponse([{ type: 'tool_use', name: 'Agent', input: args }]), true)
    expect(records).toEqual(
      archived([
        {
          type: 'tool_use',
          name: 'Agent',
          input: '[redacted]',
          agent_call: detected
        }
      ])
    )
    expect(JSON.stringify(records)).not.toContain('SECRET_')
    expect(logs.join('')).not.toContain('SECRET_')
    expect(logs.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'agent_call_detected', sessionId: 'session-agent', ...detected })
      ])
    )
    expect(logs.join('')).not.toContain('PRIVATE_PROMPT')
  })

  test('does not infer calls from text, nested data, similarly named tools or server tools', async () => {
    const content = [
      { type: 'text', text: 'Agent Task {"prompt":"work","subagent_type":"Explore"}' },
      { type: 'tool_use', name: 'Bash', input: { Agent: input } },
      ...['agent', 'TaskOutput', 'mcp__tools__Agent'].map((name) => ({ type: 'tool_use', name, input }))
    ]
    const { records } = await capture(
      jsonResponse([
        ...content,
        { type: 'server_tool_use', name: 'Agent', input },
        { type: 'thinking', thinking: 'Agent' }
      ])
    )
    expect(records).toEqual(archived(content))
  })

  test('a cut-off or malformed call is identified by name but does not claim parsed argument fields', async () => {
    const { records } = await capture(sseResponse([start(0, 'Agent'), delta(0, '{"prompt":"unfinished')]))
    expect(records).toEqual(
      archived([
        {
          type: 'tool_use',
          id: 'tool-0',
          name: 'Agent',
          input: '{"prompt":"unfinished',
          agent_call: { prompt_present: false, subagent_type_present: false, model_present: false }
        }
      ])
    )
  })

  test('presence means string-valued fields, not validated parameters or a proven launch', async () => {
    const args = { prompt: 1, subagent_type: null, model: [] }
    const { records } = await capture(jsonResponse([{ type: 'tool_use', name: 'Agent', input: args }]))
    expect(records).toEqual(
      archived([
        {
          type: 'tool_use',
          name: 'Agent',
          input: args,
          agent_call: { prompt_present: false, subagent_type_present: false, model_present: false }
        }
      ])
    )
  })

  test('ignores unrelated response wire formats and invalid JSON', async () => {
    expect(
      (await capture(new Response('{broken', { headers: { 'content-type': 'application/json' } }))).records
    ).toEqual([])
    expect(
      (
        await capture(
          new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ name: 'Agent' }] } }] }), {
            headers: { 'content-type': 'application/json' }
          })
        )
      ).records
    ).toEqual([])
  })
})

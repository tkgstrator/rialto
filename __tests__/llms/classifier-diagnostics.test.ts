import { describe, expect, test } from 'bun:test'
import pino from 'pino'
import {
  captureSafeguardResultMetadata,
  classifierSignals,
  hasSafeguards
} from '../../src/llms/pipeline/classifier-diagnostics'

const captured: string[] = []
const log = pino({ level: 'info' }, { write: (line: string) => captured.push(line) })

const waitForLog = async () => {
  for (let i = 0; i < 20 && captured.length === 0; i++) await Bun.sleep(5)
}

describe('classifier diagnostics', () => {
  test('distinguishes explicit safeguards from a heuristic permission gate', () => {
    expect(classifierSignals({ safeguards: {}, messages: [] })).toEqual({
      safeguardsPresent: true,
      suspectedClassifier: false
    })
    expect(classifierSignals({ system: [{ type: 'text', text: 'Stage 1 does NOT apply user intent' }] })).toEqual({
      safeguardsPresent: false,
      suspectedClassifier: true
    })
    expect(
      classifierSignals({
        system: 'ordinary conversation',
        messages: [{ content: 'Stage 1 does NOT apply user intent' }]
      })
    ).toEqual({ safeguardsPresent: false, suspectedClassifier: false })
    expect(hasSafeguards({ model: 'codex' })).toBe(false)
  })

  test('logs only small JSON result metadata, never decisions or text', async () => {
    captured.length = 0
    const raw = JSON.stringify({ safeguard_results: [{ decision: 'SECRET_DECISION' }], content: 'SECRET_PROMPT' })
    captureSafeguardResultMetadata(
      new Response(raw, { headers: { 'content-type': 'application/json', 'content-length': String(raw.length) } }),
      log
    )
    await waitForLog()
    expect(captured.length).toBe(1)
    expect(JSON.parse(captured[0]).safeguardResultCount).toBe(1)
    expect(captured[0]).not.toContain('SECRET_')
  })

  test('does not read streaming responses', async () => {
    captured.length = 0
    let pulled = false
    const stream = new ReadableStream({
      pull() {
        pulled = true
      }
    })
    captureSafeguardResultMetadata(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), log)
    expect(pulled).toBe(false)
    expect(captured).toHaveLength(0)
  })
})

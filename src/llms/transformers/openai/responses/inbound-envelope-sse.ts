import { isObject } from '../../../utils/guards'

// ─── SSE: wrap a Responses envelope as a minimal Responses SSE stream ──

/**
 * Emit the fully-assembled Responses envelope as a short SSE sequence:
 *
 *   response.created         (skeleton)
 *   response.in_progress     (skeleton)
 *   response.output_item.added / *.done for each output item
 *   response.output_text.delta / *.done for the message text (if any)
 *   response.completed       (full envelope)
 *
 * Buffered by construction: it needs the finished envelope. The live
 * path is `convertChatSseToResponsesSse` in `./inbound-stream.ts`, which
 * emits this same vocabulary as the upstream produces it; this remains
 * for the case where there is no body left to read incrementally, and
 * for callers that already hold a complete envelope.
 */
export function wrapResponsesEnvelopeAsSse(envelope: Record<string, unknown>): string {
  const lines: string[] = []
  const skeleton = { ...envelope, output: [] }
  lines.push(sseEvent('response.created', { type: 'response.created', response: skeleton }))
  lines.push(sseEvent('response.in_progress', { type: 'response.in_progress', response: skeleton }))
  const outputs = Array.isArray(envelope.output) ? envelope.output : []
  for (let i = 0; i < outputs.length; i++) {
    const item = outputs[i]
    if (!isObject(item)) continue
    lines.push(
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: i,
        item
      })
    )
    if (item.type === 'message') {
      const contentBlocks = Array.isArray(item.content) ? item.content : []
      for (let ci = 0; ci < contentBlocks.length; ci++) {
        const block = contentBlocks[ci]
        if (!isObject(block) || block.type !== 'output_text' || typeof block.text !== 'string') continue
        lines.push(
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: i,
            content_index: ci,
            delta: block.text
          })
        )
        lines.push(
          sseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: i,
            content_index: ci,
            text: block.text
          })
        )
      }
    } else if (item.type === 'function_call') {
      const args = typeof item.arguments === 'string' ? item.arguments : ''
      lines.push(
        sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: i,
          delta: args
        })
      )
      lines.push(
        sseEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: item.id,
          output_index: i,
          arguments: args
        })
      )
    } else if (item.type === 'custom_tool_call') {
      // The custom kind has its own pair of events, and the Codex CLI
      // reads the call's text off them rather than off the item — a
      // function_call_arguments pair here would leave it with an empty
      // command to run.
      const callInput = typeof item.input === 'string' ? item.input : ''
      lines.push(
        sseEvent('response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          item_id: item.id,
          output_index: i,
          delta: callInput
        })
      )
      lines.push(
        sseEvent('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          item_id: item.id,
          output_index: i,
          input: callInput
        })
      )
    }
    lines.push(
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: i,
        item
      })
    )
  }
  lines.push(sseEvent('response.completed', { type: 'response.completed', response: envelope }))
  return lines.join('')
}

function sseEvent(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

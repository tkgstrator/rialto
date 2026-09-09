/**
 * SSE→JSON aggregators, one per inbound surface.
 *
 * Needed because some provider paths (codex-oauth notably) force
 * `stream=true` upstream even when the inbound client asked for a
 * blocking JSON response. Without a per-shape aggregator the /v1
 * handler would `JSON.parse("event: ...\ndata: ...")` and 500.
 *
 * One file per wire format, because that is the only boundary these
 * share: an Anthropic `content_block_delta` and a Gemini `candidates[]`
 * chunk have no vocabulary in common, and the sole shared code is the
 * SSE framing in `parse.ts`. Which surface uses which is not decided
 * here — each descriptor names its own in `InboundSurface.aggregateSse`,
 * so a surface can never fold a stream with another surface's envelope.
 *
 * Unrecognised event types and malformed events are dropped rather than
 * throwing — a partial reconstruction beats a 500 for the client.
 *
 * This barrel is the import path for all of them, so a call site never
 * has to know which file an aggregator lives in.
 */

export { aggregateAnthropicSseToJson } from './anthropic'
export { aggregateGeminiSseToJson } from './gemini'
export { aggregateOpenAiChatSseToJson } from './openai-chat'
export { aggregateOpenAiResponsesSseToJson } from './openai-responses'
// `parseSseEvents` is deliberately NOT re-exported: it is the framing
// the four aggregators share, not something a call site outside this
// directory has ever needed. Anything that does need it can import
// `./parse` and say so explicitly.
export { findSseStreamDefect, isSseContentType, type SseStreamDefect } from './parse'

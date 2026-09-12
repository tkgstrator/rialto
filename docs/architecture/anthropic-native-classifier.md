# Native Anthropic traffic and Claude Code classifiers

An Anthropic API-key provider must have the sole `anthropic` transformer in its
provider chain. This selects the pipeline's native path: preserve the request,
strip inbound credentials and proxy headers, run the endpoint's API-key auth hook,
and return native JSON or SSE without converting it to or from Chat Completions.

An empty chain is not native passthrough. It runs the inbound Anthropic-to-unified
conversion, then sends that Chat-shaped body without an outbound conversion.
Responses are also interpreted as Chat Completions. Consequences include malformed
tool definitions upstream and a `Provider error` for an otherwise valid Anthropic
classifier response. System blocks, thinking settings and stop sequences must stay
in their native positions rather than being lost in an unnecessary conversion.

Claude Code subscription providers remain a single `claude-code-oauth` step.
Adding `anthropic` in front of that step would disable the single-step native path.
OpenAI, Responses, Gemini and per-model conversion chains are unchanged.

## Verification

The defect was reproduced with real Claude Code traffic through an isolated Rialto
HTTP application and the same configured upstream gateway. A captured classifier
request was replayed byte-for-byte in alternating order: the unmodified baseline
returned HTTP 500 twice; the fixed tree returned HTTP 200 twice. Applying only
`src/shared/transformer-chain.ts` also allowed auto-mode classification and the
subsequent harmless calculation command to complete, as well as a CLI structured
output request.

The captured permission classifier used an XML response and did not carry
`output_config.format`. The CLI structured-output case used a `StructuredOutput`
tool. Preserving JSON-schema output configuration is a separate concern, not the
cause isolated by this comparison. The experiment does not claim that every
subscription or cross-provider configuration was broken or has been verified.

## Regression tests

`__tests__/llms/anthropic-native-pipeline.test.ts` runs the real registry and HTTP
pipeline against a loopback fixture upstream. It verifies the native classifier
request and JSON response, provider authentication and inbound-header stripping,
and native tool definitions and SSE bytes. It needs no database, credentials or
live model. The chain mapping and provider registry tests also pin the native
API-key chain and the unchanged subscription chains.

The native pipeline cases fail against the old empty-chain implementation and pass
with the sole `anthropic` step. No real classifier prompts or credentials are
included in these fixtures.

# Permission requests through Rialto

Claude Code can issue two distinct kinds of permission-related requests. A JSON
output constraint does not by itself implement server-side Safeguards.

## Structured classifier output

Anthropic `output_config.format` and the legacy `output_format` are preserved
when Messages requests are converted to Codex. The supplied JSON Schema becomes
Responses `text.format`; modern format takes precedence, including explicit
`null`. Subscription-specific effort is handled separately from the format.

`classifier_diagnostic` records whether a JSON schema was requested and forwarded,
without logging the schema or prompt. A successful structured response proves
format compatibility, not that Claude Code accepted the permission decision.

## Native server-side Safeguards

A request carrying the `safeguards` field, even if empty or null, is eligible only
for a native Anthropic Messages bypass. Incompatible candidates are skipped and
only native candidates already in the operator's routing chain are considered.
If no usable native target remains, the request fails closed with HTTP 400;
a genuine upstream error takes precedence over that compatibility error.

Codex does not implement Anthropic Safeguards. Rialto does not synthesize approval
results or disable permission checks to make converted requests succeed.
Native requests retain their Safeguards fields, capability headers and results.
For streaming, clients must receive the final `message_delta` containing
`delta.safeguard_results` as well as the rest of the response.

To verify server-side evaluation, check that the returned `dangerous_tool_use`
entry has an available status and an evaluated result for the exact tool-use ID.
HTTP 200, ordinary generated text, or an empty results map is insufficient to
prove that a proposed tool call was evaluated. Client-side permission enforcement
remains Claude Code's responsibility.

A live read-only tool proposal was verified through the native subscription route
in both JSON and SSE, with matched `available` / `evaluated` / `not_flagged`
results. A Codex-requested route also returned genuine native Claude results.
No proposed tool was executed in these tests; dangerous-action denial behavior
was not live-tested. Upstream availability can vary by account and platform.

Safeguards-result diagnostics inspect only small JSON responses with a bounded
Content-Length. An absent diagnostic event does not prove results were missing;
inspect the client response when verifying JSON or SSE delivery.

## References

- [Claude Code gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Server-side classifier review](https://code.claude.com/docs/en/permission-modes#server-side-classifier-review)
- [Agent call capture](agent-call-detection.md)

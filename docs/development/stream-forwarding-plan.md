# Streaming response liveness repair

## Verified facts and limitation

- The historical first streaming request reached upstream headers in 2512 ms. Its upstream capture contains a complete tool-input JSON object and output usage. The original client-side first exception was not retained, and archive timestamps do not establish exact wire timing.
- A paced synthetic signature event through the actual production `applyResponseModelIdentity` function receives upstream chunks every 20 ms but withholds downstream progress until the complete event is available. The controlled 300 ms example forwards no signature bytes during the initial 180 ms; the output then flushes in a burst.
- This identifies an avoidable relay liveness defect. It does not establish that the historical failure was caused by this specific event shape or timing. Do not present retry suppression, a timeout increase, or negative replay results as root-cause proof.

## Intended contract

Preserve the selected provider/model identity in the initial Anthropic `message_start`, then relay the rest of that response incrementally without buffering or reserializing complete content/signature/tool-input events. This follows the single-message-envelope contract of `/v1/messages`. Other wire surfaces and blocking JSON retain their existing model-identity behavior.

The transition must not lose UTF-8 bytes when the first rewritten frame and the raw tail share a chunk. Handle LF/CRLF boundaries split across chunks, optional prelude ping/comment frames, opaque data, EOF without a trailing blank line, cancellation, and downstream backpressure. Never fabricate terminal events, replay a request, change generation deadlines, or expose private response content in diagnostics.

### Resolved review details

- Scan delimiters in bytes and decode only complete candidate head records. Preserve each original delimiter and all raw tail bytes, including a shared chunk's partial UTF-8 sequence. Join multiline `data:` values according to SSE before parsing the candidate JSON.
- Comment-only records and JSON `ping` records pass unchanged while waiting for `message_start`. A valid `message_start.message` object is rewritten once; any other data record switches to raw forwarding without interpreting later content.
- Bound only the undecided head to 64 KiB per record and 32 prelude records. On exhaustion, emit every original buffered byte and switch permanently to raw forwarding; never fail or fabricate a protocol event. The selected-model header remains available, but body-model rewriting is explicitly best-effort for an oversized, missing, opaque or incomplete initial envelope. A large tail sharing a chunk with a small head does not count toward this bound.
- EOF before a complete initial envelope preserves the exact buffered bytes. Use the native `pipeThrough` lifecycle rather than a separate read-ahead pump. Keep the existing generic behavior for other surfaces, including both Responses lifecycle envelopes.
- The LocalGPT Pro plan request has an unconfirmed result following a history rate limit; it must not be resent. A separate native Codex read-only reviewer verified the source hash and independently reviewed the plan as the authorized alternative. Claude's independent repository review completed; both identified the byte-boundary and EOF hazards resolved here.

## Implementation and proof

1. Independent LocalGPT plan review and Claude repository-feasibility review before product edits.
2. Add a deterministic RED regression demonstrating byte progress before a large non-model-bearing event is complete. Keep all fixture data synthetic and use a barrier instead of slow production-duration sleeps.
3. Implement a minimal Anthropic-specific prefix-rewrite/raw-tail path; keep the generic stream path unchanged. Follow repository strict TypeScript/Biome rules and preserve selected-model provenance headers.
4. Regress byte-for-byte tail preservation, first-frame model identity, split delimiters and UTF-8, preludes, EOF, error/cancellation propagation, backpressure and other surfaces.
5. Focused Bun tests, relevant static checks, required full suite/CI, and a paced integration probe using production-equivalent Bun 1.4. Do not run a dev server or alter production code during a diagnostic probe.
6. Independent actual-diff review tied to source hashes; resolve material findings before feature PR squash-merge into `develop`. Only `develop` may open the release PR to `master`; no feature version bump.
7. Verify published image revision/digest and an authorized isolated gateway rollout before making deployment claims. Keep rollback and live requests safe. The Claude MCP repair PR4/image is already independently deployed; do not regress it or conflate the two rollouts.

## Workspace and baseline

- Isolated worktree: `/Users/devonly/Developer/rialto-stream-progress-20261019`, branch `codex/stream-anthropic-tail`, base `9569e7b5bf1f2b970efc8506ac1e5c08d5acb27e`.
- Production Rialto revision: `47547d2697df47ca873b927fabba55b0886aa51e`, version 2.104.9, Bun 1.4.0. The base differs only in four CI/development-documentation files; runtime source is identical.
- Preserve dirty main checkout and the older held abort-plumbing worktree. They are not implementation inputs for this repair.
- Evidence: `/Users/devonly/Developer/claude-mcp-goal-evidence-20261019-ERXP7w/relay-progress-probe.json` and `historical-response-metrics.json`, containing structural metadata only.

# Decision routing

Rialto can optionally ask a SystemOne-compatible Decisions API to prefer one of the already configured tier routes for a routing profile. This is a preference, not a second model registry: Rialto still resolves provider aliases and enforces the normal context-window, web-search, quota, health and failover gates.

## Profile settings

The following keys belong in a profile's `constraints` object, returned and accepted by `GET` / `PUT /api/routing/profiles/{key}`:

| Key | Meaning |
| --- | --- |
| `decisionEnabled` | Enables the optional request-time classifier. Defaults to `false`. |
| `decisionApiBaseUrl` | SystemOne-compatible service origin, for example `https://api.typesafe.ai` or `http://jeff:8000`. |
| `decisionModel` | Decision service model, for example `jev-latest` or `jeff-latest`. |
| `decisionApiKeyEnv` | Optional environment-variable name that supplies the Bearer token. The token itself is never stored in profile JSON. |
| `decisionMinConfidence` | Minimum returned confidence required to change the route preference. Defaults to `0.9`. |
| `decisionTimeoutMs` | Per-request classifier deadline. Defaults to `1500` ms and is capped at `10000` ms. |

A profile is left in its configured route order unless every required setting is present and the classifier returns one of the tiers that is already eligible on that profile's selected scenario and lane.

## Request contents

The outbound `state` is intentionally limited to routing metadata:

- scenario, token count, thinking and subagent flags;
- whether tools or hosted web search are present; and
- the caller's requested model name.

Rialto does not send messages, system prompts, source code, tool arguments, images or API credentials to a Decision service. This makes a hosted service such as Jev safe to trial without expanding the request-data boundary. It also means the first version is a metadata classifier; deployments that need semantic task classification should add an explicit, redacted task-summary contract rather than silently exporting raw prompts.

## Failure behavior

Decision routing is fail-open. Disabled, incomplete, timed-out, non-2xx, malformed, unavailable and low-confidence responses keep the profile's original order. A classifier cannot introduce a provider/model that is not already configured, bypass a capability gate or remove the regular fallback chain.

## Observability

Each classifier invocation emits one structured `[routing] decision` log with `event: routing_decision`:

- `outcome: success`, `reason: accepted`: an eligible tier met the confidence threshold.
- `outcome: skipped`: disabled or incomplete configuration, fewer than two candidate tiers, or a missing API key.
- `outcome: fallback`: HTTP errors, invalid JSON or answers, low confidence, timeouts, or network errors.

Logs include the scenario, candidate tiers, minimum confidence and elapsed milliseconds. Parsed answers include `predictedTier` (and the legacy `tier`), `confidence`, candidate-keyed `probabilities`, and `chosenProbability`, even when confidence is too low to accept. Only finite probabilities between zero and one for offered candidates are retained; missing or entirely invalid distributions are `null`, and a missing chosen probability is also `null`. `decisionAccepted` distinguishes an accepted preference from a rejected prediction. HTTP failures include their status code. Success and skip events use `info`, while fallback events use `warn`.

Jeff choice confidence is a normalized advantage over a uniform distribution, **not** the chosen probability: `confidence = (p_max - 1/N) / (1 - 1/N)`, clamped to zero through one. With four candidates, confidence `0.19` corresponds to chosen probability `0.3925`; the unchanged default confidence threshold `0.9` corresponds to probability `0.925`.

The inbound request receives an internal `reqId` before routing. Decision logs and all upstream attempts share that id; each upstream send also receives a distinct `attemptId`. `event: routing_upstream` records `outcome: send`, followed by `success` with the HTTP status, or `failure` with an HTTP status or a metadata-only network-error reason. A send event is not success. Success here means the upstream accepted the HTTP request, not that a streaming response completed or that task quality was validated.

Upstream observations carry the provider, the model from the transformed outbound body or explicit transformer metadata for URL-based vendors such as Gemini, and `selectedTier` / `selectedRoute` from the selector's candidate identity. Tier is never inferred from the concrete model name: different tier aliases may resolve to the same model. When the chain deduplicates such targets, the first candidate in selector order supplies the identity. Passthrough and legacy contexts without selector metadata report a null selected tier. Live gates, pace ordering and reactive failover can make the sent tier differ from the prediction.

Both observation types explicitly carry `expectedTier: null` and `evaluationStatus: unrated`. Neither the requested model, prediction nor actual upstream is a ground-truth quality label. Upstream observations remain JSON-log-only; the decision-input archive below is separate from RequestLog storage and does not backfill historical rows.

Use the existing log viewer to search for `[routing] decision`, or filter JSON log files by `event == "routing_decision"`. Logging follows the ordinary `LOG` and `LOG_LEVEL` settings; it does not require `JEFF_SHADOW_ENABLED`. Request bodies, credentials, endpoint URLs, raw responses and exception messages are not logged. These are classifier observations, not a record of the final upstream selected by the subsequent capability and quota gates.

## Decision-input archive

When request capture is enabled (the existing `CAPTURE_REQUESTS` switch defaults to enabled), each attempted live classifier call stores a `RoutingDecision` row. `CAPTURE_REQUESTS=false` disables these writes before acquiring a database client. Skipped evaluations create no row because nothing was sent. Accepted, low-confidence, HTTP-failure, malformed-response, timeout and network-failure attempts all retain their exact serialized SystemOne `requestBody` alongside the normalized decision, threshold, duration, HTTP status when available, and `reqId`. Query the archive by `reqId` to correlate it with decision and upstream file-log events; this is not a RequestLog foreign key, because failed and usage-free calls need not produce a usage row.

The stored body is the same string passed to the classifier fetch, including the configured decision-model identifier, state, fixed English instruction and candidate criteria. It includes the caller's requested model identifier without replacing it with a reconstructed value. The instruction is English; this is **not** language detection or translation of the caller's messages. Those messages are not sent to the live classifier or added to this archive. HTTP headers, endpoint URLs, API keys, environment credentials and raw classifier responses are excluded. Normalized probability keys are limited to offered candidates, and expected tier remains null/unrated.

Treat this DB archive as potentially sensitive request data: it is not added to console/file logs or a public API endpoint. There is no automatic expiry or historical backfill; rows remain until the operator deliberately deletes them. The archive is independent of existing RequestLog/Message pruning. The created-at index supports an operator-selected retention cutoff without silently choosing one on their behalf.

Persistence is asynchronous and best-effort. A missing migration, unavailable database or write failure must not change routing, confidence thresholds or the classifier timeout. Capture failures emit only a metadata-only warning with `reqId`, never the body or database exception. An abrupt process exit may lose an in-flight archive write; this is an observability archive, not a transactionally guaranteed audit ledger.

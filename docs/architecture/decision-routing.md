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

Logs include the scenario, candidate tiers, minimum confidence and elapsed milliseconds. Parsed answers also include the proposed tier and confidence, even when the confidence is too low to accept; HTTP failures include their status code. Success and skip events use `info`, while fallback events use `warn`.

Use the existing log viewer to search for `[routing] decision`, or filter JSON log files by `event == "routing_decision"`. Logging follows the ordinary `LOG` and `LOG_LEVEL` settings; it does not require `JEFF_SHADOW_ENABLED`. Request bodies, credentials, endpoint URLs, raw responses and exception messages are not logged. These are classifier observations, not a record of the final upstream selected by the subsequent capability and quota gates.
